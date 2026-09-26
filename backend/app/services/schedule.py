"""Horarios estimados: a qué hora empieza cada combate pendiente.

Para cada tatami se recorre su cola (el mismo orden que la planilla y la mesa,
``brackets.schedule_items``) y se asigna una hora a cada combate que falta:

* **Duración de un combate** = duración de la categoría (kumite: la de sus
  reglas; kata: ``KATA_SECONDS``) × el *ritmo* real del tatami, más el margen
  entre combates del torneo (``match_overhead_seconds``, 60 s por defecto:
  saludo, llamado, cambio de protecciones).
* **Ritmo del tatami** = cuánto duraron de verdad sus últimos combates cerrados
  (``started_at``→``finished_at``) frente a lo nominal, acotado a 0,5–3. Con
  menos de ``MIN_SAMPLES`` combates se mezcla con 1 (la duración nominal) para
  que el primer combate largo no dispare todas las horas.
* **Punto de partida** = lo más tarde entre ahora, la hora planificada del
  tatami (``tatamis.planned_start``, en la hora local del torneo) y el final
  esperado del combate en curso. Sin hora planificada ni combates empezados, y
  con el torneo sin iniciar, no se estima nada: no hay de dónde partir.

Las horas se redondean al minuto: así la instantánea pública no cambia de ETag
en cada recálculo si nada se movió. Se calcula junto con la instantánea
pública (``app.services.public``), no en cada visita, y en la cola del tatami
del organizador con las filas que esa consulta ya cargó (sin consultas extra).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session, lazyload

from app.api.errors import Conflict, NotFound
from app.api.schemas import ScheduleSettingsIn, TatamiUpdate
from app.db.base import utcnow
from app.db.models import Category, Match, Tatami, Tournament, User
from app.services.audit import audit, bump
from app.services.brackets import SCHEDULED, queue_order, schedule_items

DEFAULT_TZ = "America/Lima"
KATA_SECONDS = 120  # una ejecución de kata con su calificación
MIN_SAMPLES = 3  # combates cerrados para confiar del todo en el ritmo real
SAMPLES = 10  # se miran los últimos N combates cerrados del tatami
FACTOR_RANGE = (0.5, 3.0)
# Sin la base de zonas horarias (imagen mínima sin tzdata), Lima: UTC−5 todo el año.
_LIMA = timezone(timedelta(hours=-5), "PET")


def zone(name: str | None) -> tzinfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        return _LIMA


def valid_timezone(name: str) -> bool:
    if name == DEFAULT_TZ:
        return True
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def local_to_utc(value: datetime | None, tz: tzinfo) -> datetime | None:
    """Hora local sin zona (lo que escribe el organizador) → UTC sin zona (como la base)."""
    if value is None:
        return None
    aware = value.replace(tzinfo=tz) if value.tzinfo is None else value
    return aware.astimezone(UTC).replace(tzinfo=None)


def to_local(value: datetime | None, tz: tzinfo) -> datetime | None:
    """Fecha y hora con zona → hora local del torneo sin zona (para guardar ``planned_start``)."""
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(tz).replace(tzinfo=None)


def iso_local(value: datetime | None, tz: tzinfo) -> str | None:
    """UTC sin zona → ISO con la zona del torneo («2026-10-17T11:40:00-05:00»)."""
    if value is None:
        return None
    return value.replace(tzinfo=UTC).astimezone(tz).isoformat()


def _minute(value: datetime) -> datetime:
    return (value + timedelta(seconds=30)).replace(second=0, microsecond=0)


def nominal_seconds(c: Category, t: Tournament) -> int:
    if c.modality == "kata":
        return KATA_SECONDS
    from app.services.tournaments import effective_kumite_rules

    return int(effective_kumite_rules(c, t).duration_seconds)


def _factor(samples: list[tuple[float, float]]) -> float:
    """Ritmo real (duración real / nominal) de los últimos combates, mezclado con 1 si hay pocos."""
    samples = samples[-SAMPLES:]
    n = len(samples)
    if not n:
        return 1.0
    real = sum(r for r, _ in samples)
    nominal = sum(x for _, x in samples) or 1.0
    f = min(max(real / nominal, FACTOR_RANGE[0]), FACTOR_RANGE[1])
    return (n * f + max(0, MIN_SAMPLES - n)) / max(n, MIN_SAMPLES)


def plan(
    t: Tournament,
    tatamis: Iterable[Tatami],
    categories: Iterable[Category],
    matches: list[Match],
    now: datetime | None = None,
    sched: dict[int, list[dict]] | None = None,
) -> dict[int, datetime]:
    """Hora estimada de inicio (UTC sin zona) de cada combate pendiente, por id.

    Sin consultas: todo a partir de filas ya cargadas. ``sched`` (el orden de
    ``schedule_items``) se reutiliza si quien llama ya lo tiene.
    """
    now = now or utcnow()
    tatamis = list(tatamis)
    cats = {c.id: c for c in categories}
    if sched is None:
        sched = schedule_items(tatamis, queue_order([c for c in cats.values() if c.tatami_id]), matches)
    tz = zone(t.timezone)
    overhead = timedelta(seconds=max(0, t.match_overhead_seconds or 0))
    nominal: dict[int, int] = {}

    def nom(cid: int) -> int:
        if cid not in nominal:
            nominal[cid] = nominal_seconds(cats[cid], t) if cid in cats else 180
        return nominal[cid]

    out: dict[int, datetime] = {}
    for tat in tatamis:
        items = sched.get(tat.id, [])
        closed = sorted(
            (
                it["match"]
                for it in items
                if it["match"].status == "finished"
                and it["match"].started_at
                and it["match"].finished_at
                and it["match"].finished_at > it["match"].started_at
            ),
            key=lambda m: m.finished_at,
        )
        factor = _factor([((m.finished_at - m.started_at).total_seconds(), nom(m.category_id)) for m in closed])
        planned = local_to_utc(tat.planned_start, tz)
        started = any(it["match"].started_at for it in items)
        if planned is None and not started and t.status != "in_progress":
            continue  # sin hora planificada ni actividad: no hay de dónde partir
        cursor = max(x for x in (now, planned) if x is not None)
        last = max((m.finished_at for m in closed), default=None)
        if last is not None:
            cursor = max(cursor, last + overhead)
        for it in items:
            m = it["match"]
            if m.status not in ("pending", "ready", "in_progress"):
                continue  # cerrado, en revisión o sin combate
            length = timedelta(seconds=nom(m.category_id) * factor)
            if m.status == "in_progress" and m.started_at:
                out[m.id] = _minute(m.started_at)
                cursor = max(cursor, max(now, m.started_at + length) + overhead)
                continue
            out[m.id] = _minute(cursor)
            cursor += length + overhead
    return out


def estimate(db: Session, tournament_id: int, now: datetime | None = None) -> dict[int, datetime]:
    """Hora estimada de cada combate pendiente del torneo (tres consultas)."""
    t = db.get(Tournament, tournament_id)
    if t is None:
        return {}
    cats = list(
        db.scalars(
            select(Category).where(
                Category.tournament_id == t.id, Category.tatami_id.is_not(None), Category.status.in_(SCHEDULED)
            )
        ).all()
    )
    matches = (
        list(
            db.scalars(
                select(Match).where(
                    Match.category_id.in_([c.id for c in cats]), Match.is_current, Match.parent_match_id.is_(None)
                )
            ).all()
        )
        if cats
        else []
    )
    return plan(t, t.tatamis, cats, matches, now)


# ---------------------------------------------------------------------------
# Edición (organizador)
# ---------------------------------------------------------------------------


def update_settings(db: Session, user: User, tid: int, data: ScheduleSettingsIn) -> Tournament:
    """Zona horaria y margen entre combates del torneo (auditado)."""
    t = db.get(Tournament, tid)
    if t is None:
        raise NotFound("Torneo no encontrado")
    before = {"timezone": t.timezone, "match_overhead_seconds": t.match_overhead_seconds}
    if data.timezone is not None:
        if not valid_timezone(data.timezone):
            raise Conflict(f"Zona horaria desconocida: {data.timezone}", code="INVALID_TIMEZONE")
        t.timezone = data.timezone
    if data.match_overhead_seconds is not None:
        t.match_overhead_seconds = data.match_overhead_seconds
    bump(t, user)
    after = {"timezone": t.timezone, "match_overhead_seconds": t.match_overhead_seconds}
    audit(db, user, "tournament", t.id, "schedule_settings", before, after, tournament_id=t.id)
    db.commit()
    db.refresh(t)
    return t


def update_tatami(db: Session, user: User, tatami_id: int, data: TatamiUpdate) -> Tatami:
    """Nombre y hora planificada de inicio de un tatami (auditado)."""
    tat = db.get(Tatami, tatami_id)
    if tat is None:
        raise NotFound("Tatami no encontrado")
    before = {"name": tat.name, "planned_start": tat.planned_start.isoformat() if tat.planned_start else None}
    fields = data.model_dump(exclude_unset=True)
    if fields.get("name"):
        tat.name = fields["name"].strip()
    if "planned_start" in fields:
        tat.planned_start = to_local(fields["planned_start"], zone(tat.tournament.timezone))
        if tat.planned_start is not None:
            tat.planned_start = tat.planned_start.replace(second=0, microsecond=0)
    after = {"name": tat.name, "planned_start": tat.planned_start.isoformat() if tat.planned_start else None}
    audit(db, user, "tatami", tat.id, "update", before, after, tournament_id=tat.tournament_id)
    db.commit()
    db.refresh(tat)
    return tat


def for_tatami(db: Session, tat: Tatami, categories: list[Category], items: list[dict]) -> dict[int, str | None]:
    """Horas estimadas de la cola de un tatami (ISO con la zona del torneo), a
    partir de lo que la cola ya cargó: una sola consulta más (el torneo)."""
    t = db.get(Tournament, tat.tournament_id, options=[lazyload(Tournament.tatamis)])
    if t is None:
        return {}
    tz = zone(t.timezone)
    etas = plan(t, [tat], categories, [], sched={tat.id: items})
    return {mid: iso_local(v, tz) for mid, v in etas.items()}
