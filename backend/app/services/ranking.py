"""Ranking por temporada o liga (ver ``docs/ranking.md``).

Una temporada (``ranking_seasons``) dice qué torneos cuentan y cuántos puntos
da cada lugar. El cálculo se hace por lotes (unas diez consultas para toda la
temporada) y se guarda materializado en ``ranking_entries``:

* **Personas**, dentro de su categoría «equivalente»: modalidad, individual o
  equipos, sexo, rango de edad, rango de grado y peso. Así «Kumite 12-13 M -45»
  de dos torneos distintos suma en la misma tabla aunque cada torneo la haya
  llamado a su manera. La etiqueta es el nombre de la categoría de la plantilla
  (si la categoría vino de una) o el de la categoría. Una categoría sin edad ni
  peso (p. ej. «Open») se agrupa por el nombre de la plantilla o, sin
  plantilla, por su código.
* **Dojos** («mejor academia»): suma de los puntos de sus competidores.

Puntos: el podio recibe los del lugar (oro 10, plata 7, bronce 5 por defecto)
y el resto de quienes compitieron, los de participación (1). Cada torneo puede
tener un multiplicador (un nacional ×2). Un podio sin combate (inscrito único o
rival que no se presentó) solo puntúa si la categoría tuvo al menos
``min_entrants_walkover_gold`` competidores; si no, cuenta como participación.

Caché: la temporada guarda una huella de los resultados con que se calculó
(cantidad y última modificación de los podios de sus torneos). Al leer se
compara con la actual en una consulta: si una categoría se cerró o reabrió
desde entonces, se recalcula en ese momento. También se puede forzar.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.errors import InvalidState, NotFound
from app.db.base import utcnow
from app.db.models import (
    Category,
    CategoryResult,
    Dojo,
    Person,
    RankingEntry,
    RankingSeason,
    TemplateCategory,
    Tournament,
    User,
)
from app.domain.categories import age_at
from app.domain.identity import normalize_name
from app.services.audit import audit, bump, check_version
from app.services.certificates import Participation, _people, participations
from app.services.checkin import weight_range
from app.services.public import short_name

DEFAULT_POINTS = {"gold": 10, "silver": 7, "bronze": 5, "participation": 1}
PLACE_KEY = {1: "gold", 2: "silver", 3: "bronze"}


# ---------------------------------------------------------------------------
# Temporadas
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:60] or "temporada"


def get_season(db: Session, sid: int) -> RankingSeason:
    s = db.get(RankingSeason, sid)
    if s is None:
        raise NotFound("Temporada no encontrada")
    return s


def by_slug(db: Session, slug: str) -> RankingSeason:
    s = db.scalar(select(RankingSeason).where(RankingSeason.slug == slug))
    if s is None:
        raise NotFound("Temporada no encontrada")
    return s


def _points(data_points: dict[str, Any] | None) -> dict[str, float]:
    p = {**DEFAULT_POINTS, **(data_points or {})}
    return {k: float(p[k]) for k in DEFAULT_POINTS}


def _check_dates(date_from: date | None, date_to: date | None) -> None:
    if date_from and date_to and date_from > date_to:
        raise InvalidState("La fecha de inicio de la temporada es posterior a la de fin")


def create_season(db: Session, user: User, data: dict[str, Any]) -> RankingSeason:
    _check_dates(data.get("date_from"), data.get("date_to"))
    base = slugify(data.get("slug") or f"{data['name']}-{data['year']}")
    slug, n = base, 2
    while db.scalar(select(RankingSeason.id).where(RankingSeason.slug == slug)):
        slug, n = f"{base}-{n}", n + 1
    s = RankingSeason(
        name=data["name"],
        slug=slug,
        year=data["year"],
        date_from=data.get("date_from"),
        date_to=data.get("date_to"),
        tournament_ids=sorted(set(data.get("tournament_ids") or [])),
        points=_points(data.get("points")),
        multipliers={str(k): float(v) for k, v in (data.get("multipliers") or {}).items()},
        min_entrants_walkover_gold=data.get("min_entrants_walkover_gold", 2),
        is_public=data.get("is_public", False),
        updated_by_id=user.id,
    )
    db.add(s)
    db.flush()
    audit(db, user, "ranking_season", s.id, "create", after={"name": s.name, "slug": s.slug, "year": s.year})
    db.commit()
    db.refresh(s)
    return s


def update_season(db: Session, user: User, sid: int, data: dict[str, Any]) -> RankingSeason:
    s = get_season(db, sid)
    check_version(s, data.pop("version", None), "La temporada")
    before = {k: getattr(s, k) for k in data}
    for k, v in data.items():
        if k == "points":
            v = _points(v)
        elif k == "multipliers":
            v = {str(a): float(b) for a, b in (v or {}).items()}
        elif k == "tournament_ids":
            v = sorted(set(v or []))
        elif k == "slug":
            v = slugify(v)
            if db.scalar(select(RankingSeason.id).where(RankingSeason.slug == v, RankingSeason.id != s.id)):
                raise InvalidState("Ya existe otra temporada con ese enlace")
        setattr(s, k, v)
    _check_dates(s.date_from, s.date_to)
    s.source_fingerprint = None  # la configuración cambió: recalcular al leer
    bump(s, user)
    after = {k: getattr(s, k) for k in data}
    audit(db, user, "ranking_season", s.id, "update", _jsonable(before), _jsonable(after))
    db.commit()
    db.refresh(s)
    return s


def _jsonable(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v.isoformat() if isinstance(v, date) else v for k, v in d.items()}


def delete_season(db: Session, user: User, sid: int) -> None:
    s = get_season(db, sid)
    db.execute(delete(RankingEntry).where(RankingEntry.season_id == s.id))
    audit(db, user, "ranking_season", s.id, "delete", before={"name": s.name, "slug": s.slug})
    db.delete(s)
    db.commit()


# ---------------------------------------------------------------------------
# Cálculo
# ---------------------------------------------------------------------------


def season_range(s: RankingSeason) -> tuple[date, date]:
    return s.date_from or date(s.year, 1, 1), s.date_to or date(s.year, 12, 31)


def season_tournaments(db: Session, s: RankingSeason) -> list[Tournament]:
    """Torneos listados o, sin lista, todos los que no son de prueba en el rango de fechas."""
    if s.tournament_ids:
        stmt = select(Tournament).where(Tournament.id.in_(s.tournament_ids))
    else:
        lo, hi = season_range(s)
        stmt = select(Tournament).where(~Tournament.is_test, Tournament.start_date >= lo, Tournament.start_date <= hi)
    return list(db.scalars(stmt.order_by(Tournament.start_date, Tournament.id)).all())


def fingerprint(db: Session, s: RankingSeason, tids: list[int]) -> str:
    """Huella de los resultados de la temporada: cambia al cerrar o reabrir una categoría."""
    if tids:
        n, last_id, last_at = db.execute(
            select(func.count(CategoryResult.id), func.max(CategoryResult.id), func.max(CategoryResult.computed_at))
            .join(Category, Category.id == CategoryResult.category_id)
            .where(Category.tournament_id.in_(tids), Category.status == "finished")
        ).one()
    else:
        n, last_id, last_at = 0, None, None
    raw = f"{s.version}|{','.join(map(str, tids))}|{n}|{last_id}|{last_at}"
    return hashlib.sha256(raw.encode()).hexdigest()[:40]


def _num(x: Any) -> str:
    return "" if x is None else f"{Decimal(str(x)):g}"


def equivalent(c: Category, tpl_name: str | None) -> tuple[str, str]:
    """(clave, etiqueta) de la categoría equivalente entre torneos."""
    lo, hi = weight_range(c)
    team = "eq" if c.is_team else "ind"
    label = tpl_name or c.name
    if c.age_min is None and c.age_max is None and lo is None and hi is None:
        # Sin edad ni peso no hay con qué comparar: nombre de la plantilla o código.
        name = normalize_name(tpl_name) if tpl_name else f"cod:{c.code.strip().upper()}"
        return f"{c.modality}|{team}|{c.sex}|{name}"[:200], label
    parts = [
        c.modality,
        team,
        c.sex,
        f"e{_num(c.age_min)}-{_num(c.age_max)}",
        f"g{_num(c.grade_min)}-{_num(c.grade_max)}",
        f"p{_num(lo)}-{_num(hi)}",
    ]
    return "|".join(parts)[:200], label


@dataclass
class _Acc:
    points: Decimal = Decimal("0")
    golds: int = 0
    silvers: int = 0
    bronzes: int = 0
    participations: int = 0
    tournaments: set[int] = field(default_factory=set)
    label: str = ""
    modality: str = ""
    dojo_id: int | None = None
    last: date | None = None


def _award(s: RankingSeason, p: Participation, entrants: int, mult: Decimal) -> tuple[Decimal, int | None]:
    """Puntos de una participación y el lugar que cuenta como medalla (o None)."""
    pts = _points(s.points)
    place = p.place if p.place in PLACE_KEY else None
    if place and not p.fought and entrants < (s.min_entrants_walkover_gold or 0):
        place = None  # podio sin combate en una categoría chica: solo participación
    base = pts[PLACE_KEY[place]] if place else pts["participation"]
    return (Decimal(str(base)) * mult).quantize(Decimal("0.01")), place


def _add(acc: _Acc, pts: Decimal, place: int | None, tid: int) -> None:
    acc.points += pts
    if place == 1:
        acc.golds += 1
    elif place == 2:
        acc.silvers += 1
    elif place == 3:
        acc.bronzes += 1
    else:
        acc.participations += 1
    acc.tournaments.add(tid)


def _ranked(items: list[tuple[Any, _Acc]]) -> list[tuple[int, Any, _Acc]]:
    items.sort(key=lambda kv: (-kv[1].points, -kv[1].golds, -kv[1].silvers, -kv[1].bronzes, str(kv[0])))
    out, prev, rank = [], None, 0
    for i, (k, a) in enumerate(items):
        key = (a.points, a.golds, a.silvers, a.bronzes)
        if key != prev:
            rank = i + 1
        prev = key
        out.append((rank, k, a))
    return out


def compute(db: Session, s: RankingSeason) -> int:
    """Recalcula la temporada y reemplaza sus filas materializadas. Devuelve cuántas filas quedaron."""
    ts = season_tournaments(db, s)
    tids = [t.id for t in ts]
    by_t = {t.id: t for t in ts}
    mults = {tid: Decimal(str((s.multipliers or {}).get(str(tid), 1))) for tid in tids}
    cats = (
        list(db.scalars(select(Category).where(Category.tournament_id.in_(tids), Category.status == "finished")).all())
        if tids
        else []
    )
    tpl_ids = {t.template_id for t in ts if t.template_id}
    tpl_names: dict[tuple[int, str], str] = {}
    if tpl_ids:
        for tpl_id, code, name in db.execute(
            select(TemplateCategory.template_id, TemplateCategory.code, TemplateCategory.name).where(
                TemplateCategory.template_id.in_(tpl_ids)
            )
        ).all():
            tpl_names[(tpl_id, code)] = name
    groups: dict[int, tuple[str, str]] = {}
    for c in cats:
        tpl = by_t[c.tournament_id].template_id
        groups[c.id] = equivalent(c, tpl_names.get((tpl, c.code)) if tpl else None)
    parts = participations(db, cats)
    entrants: dict[int, int] = defaultdict(int)
    for p in parts:
        entrants[p.category.id] += 1
    persons: dict[tuple[str, int], _Acc] = {}
    dojos: dict[int, _Acc] = {}
    for p in parts:
        c = p.category
        t = by_t[c.tournament_id]
        pts, place = _award(s, p, entrants[c.id], mults[c.tournament_id])
        key, label = groups[c.id]
        for pid, _name in _people(p):
            if pid is None:
                continue
            acc = persons.setdefault((key, pid), _Acc(label=label, modality=c.modality))
            _add(acc, pts, place, t.id)
            if acc.last is None or t.start_date >= acc.last:
                acc.last, acc.dojo_id = t.start_date, p.registration.dojo_id
        dacc = dojos.setdefault(p.registration.dojo_id, _Acc(dojo_id=p.registration.dojo_id))
        _add(dacc, pts, place, t.id)

    db.execute(delete(RankingEntry).where(RankingEntry.season_id == s.id))
    rows: list[RankingEntry] = []
    by_group: dict[str, list[tuple[int, _Acc]]] = defaultdict(list)
    for (key, pid), acc in persons.items():
        by_group[key].append((pid, acc))
    for key, items in by_group.items():
        for rank, pid, acc in _ranked(items):
            rows.append(_entry(s.id, "person", key, acc.label, acc.modality, pid, acc.dojo_id, rank, acc))
    for rank, did, acc in _ranked(list(dojos.items())):
        rows.append(_entry(s.id, "dojo", "", "", "", None, did, rank, acc))
    db.add_all(rows)
    s.computed_at = utcnow()
    s.source_fingerprint = fingerprint(db, s, tids)
    db.commit()
    return len(rows)


def _entry(
    sid: int, kind: str, key: str, label: str, modality: str, pid: int | None, did: int | None, rank: int, a: _Acc
) -> RankingEntry:
    return RankingEntry(
        season_id=sid,
        kind=kind,
        group_key=key,
        group_label=label[:200],
        modality=modality,
        person_id=pid,
        dojo_id=did,
        points=a.points,
        rank=rank,
        golds=a.golds,
        silvers=a.silvers,
        bronzes=a.bronzes,
        participations=a.participations,
        tournaments=len(a.tournaments),
    )


def ensure_fresh(db: Session, s: RankingSeason, force: bool = False) -> None:
    """Recalcula si los resultados cambiaron desde el último cálculo (o si se fuerza)."""
    tids = [t.id for t in season_tournaments(db, s)]
    if force or s.source_fingerprint != fingerprint(db, s, tids):
        compute(db, s)


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------


def season_out(s: RankingSeason, tournaments: list[Tournament] | None = None) -> dict[str, Any]:
    out = {
        "id": s.id,
        "name": s.name,
        "slug": s.slug,
        "year": s.year,
        "date_from": s.date_from,
        "date_to": s.date_to,
        "tournament_ids": s.tournament_ids or [],
        "points": _points(s.points),
        "multipliers": s.multipliers or {},
        "min_entrants_walkover_gold": s.min_entrants_walkover_gold,
        "is_public": s.is_public,
        "computed_at": s.computed_at,
        "version": s.version,
    }
    if tournaments is not None:
        out["tournaments"] = [
            {
                "id": t.id,
                "name": t.name,
                "start_date": t.start_date,
                "multiplier": float((s.multipliers or {}).get(str(t.id), 1)),
            }
            for t in tournaments
        ]
    return out


def _display_names(db: Session, pids: set[int], s: RankingSeason, full: bool) -> dict[int, str]:
    """Nombre completo para el staff; para el público, abreviado en menores
    (misma regla que el vivo público: «Diego R.»). Sin fecha de nacimiento se
    asume menor."""
    if not pids:
        return {}
    ref = season_range(s)[1]
    out = {}
    for p in db.scalars(select(Person).where(Person.id.in_(pids))).all():
        adult = p.birth_date is not None and age_at(p.birth_date, ref) >= 18
        out[p.id] = f"{p.first_names} {p.last_names}" if full or adult else short_name(p.first_names, p.last_names)
    return out


def _dojo_names(db: Session, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    return dict(db.execute(select(Dojo.id, Dojo.name).where(Dojo.id.in_(ids))).all())


def _row(e: RankingEntry, names: dict[int, str], dojos: dict[int, str]) -> dict[str, Any]:
    return {
        "rank": e.rank,
        "person_id": e.person_id,
        "name": names.get(e.person_id, "") if e.person_id else dojos.get(e.dojo_id, ""),
        "dojo_id": e.dojo_id,
        "dojo_name": dojos.get(e.dojo_id, "") if e.dojo_id else "",
        "points": float(e.points),
        "golds": e.golds,
        "silvers": e.silvers,
        "bronzes": e.bronzes,
        "participations": e.participations,
        "tournaments": e.tournaments,
    }


def groups(db: Session, s: RankingSeason, modality: str | None = None) -> list[dict[str, Any]]:
    stmt = (
        select(RankingEntry.group_key, RankingEntry.group_label, RankingEntry.modality, func.count())
        .where(RankingEntry.season_id == s.id, RankingEntry.kind == "person")
        .group_by(RankingEntry.group_key, RankingEntry.group_label, RankingEntry.modality)
    )
    if modality:
        stmt = stmt.where(RankingEntry.modality == modality)
    rows = db.execute(stmt).all()
    # Una clave puede tener varias etiquetas (dos plantillas): se queda la más usada.
    best: dict[str, dict[str, Any]] = {}
    for key, label, mod, n in rows:
        g = best.setdefault(key, {"key": key, "label": label, "modality": mod, "competitors": 0, "_n": 0})
        g["competitors"] += n
        if n > g["_n"]:
            g["label"], g["_n"] = label, n
    out = [{k: v for k, v in g.items() if k != "_n"} for g in best.values()]
    return sorted(out, key=lambda g: (g["modality"], g["label"]))


def person_table(
    db: Session, s: RankingSeason, group_key: str | None, modality: str | None, *, full_names: bool, limit: int = 500
) -> dict[str, Any]:
    stmt = select(RankingEntry).where(RankingEntry.season_id == s.id, RankingEntry.kind == "person")
    if group_key:
        stmt = stmt.where(RankingEntry.group_key == group_key)
    if modality:
        stmt = stmt.where(RankingEntry.modality == modality)
    rows = list(
        db.scalars(stmt.order_by(RankingEntry.group_key, RankingEntry.rank, RankingEntry.id).limit(limit)).all()
    )
    names = _display_names(db, {e.person_id for e in rows if e.person_id}, s, full_names)
    dojos = _dojo_names(db, {e.dojo_id for e in rows if e.dojo_id})
    grouped: dict[str, dict[str, Any]] = {}
    for e in rows:
        g = grouped.setdefault(
            e.group_key, {"key": e.group_key, "label": e.group_label, "modality": e.modality, "rows": []}
        )
        g["rows"].append(_row(e, names, dojos))
    return {"groups": list(grouped.values())}


def dojo_table(db: Session, s: RankingSeason, limit: int = 200) -> list[dict[str, Any]]:
    rows = list(
        db.scalars(
            select(RankingEntry)
            .where(RankingEntry.season_id == s.id, RankingEntry.kind == "dojo")
            .order_by(RankingEntry.rank, RankingEntry.id)
            .limit(limit)
        ).all()
    )
    dojos = _dojo_names(db, {e.dojo_id for e in rows if e.dojo_id})
    return [_row(e, {}, dojos) for e in rows]


def person_positions(db: Session, person_id: int, *, only_public: bool = False) -> list[dict[str, Any]]:
    """Puesto de una persona en cada temporada (para su perfil)."""
    stmt = select(RankingSeason).order_by(RankingSeason.year.desc(), RankingSeason.id.desc())
    if only_public:
        stmt = stmt.where(RankingSeason.is_public)
    seasons = list(db.scalars(stmt).all())
    for s in seasons:
        ensure_fresh(db, s)
    if not seasons:
        return []
    by_id = {s.id: s for s in seasons}
    entries = db.scalars(
        select(RankingEntry).where(
            RankingEntry.person_id == person_id,
            RankingEntry.kind == "person",
            RankingEntry.season_id.in_(list(by_id)),
        )
    ).all()
    totals = {
        (sid, key): n
        for sid, key, n in db.execute(
            select(RankingEntry.season_id, RankingEntry.group_key, func.count())
            .where(RankingEntry.season_id.in_(list(by_id)), RankingEntry.kind == "person")
            .group_by(RankingEntry.season_id, RankingEntry.group_key)
        ).all()
    }
    out = []
    for e in entries:
        s = by_id[e.season_id]
        out.append(
            {
                "season_id": s.id,
                "season_name": s.name,
                "slug": s.slug,
                "year": s.year,
                "is_public": s.is_public,
                "group_key": e.group_key,
                "group_label": e.group_label,
                "modality": e.modality,
                "rank": e.rank,
                "of": totals.get((e.season_id, e.group_key), 0),
                "points": float(e.points),
                "golds": e.golds,
                "silvers": e.silvers,
                "bronzes": e.bronzes,
            }
        )
    return sorted(out, key=lambda x: (-x["year"], x["season_name"], x["rank"]))
