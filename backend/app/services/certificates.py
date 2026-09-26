"""Diplomas de podio y certificados de participación en PDF (reportlab).

Por categoría finalizada: diploma de oro, plata o bronce para el podio y
certificado de participación para quien compitió sin llegar al podio. Se
descargan por categoría, por dojo (todos los de sus competidores) o por
persona. Los textos de firma (nombre y cargo) y el organizador se editan por
torneo (``certificate_*`` en ``tournaments``).

TODO(entitlements): al integrar, estos PDF exigen la feature «certificates» del
plan (``entitlements``); el chequeo va en los routers junto a los permisos.
"""

from __future__ import annotations

import io
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import is_organizer, roles_of
from app.api.errors import InvalidState
from app.db.models import (
    Category,
    CategoryResult,
    KataPerformance,
    Match,
    Registration,
    Team,
    TeamMember,
    Tournament,
    User,
)
from app.services.checkin import NO_SHOW_REASON
from app.services.reports import AI, KASUMI, NEZUMI, SHU, SUMI, USUZUMI, _enso
from app.services.tournaments import get_category, get_tournament

Kind = Literal["podium", "participation", "all"]

KIN = colors.HexColor("#B08D3C")
GIN = colors.HexColor("#8C9094")
DOU = colors.HexColor("#9A6440")
PLACE = {
    1: ("Primer lugar", "Medalla de oro", KIN),
    2: ("Segundo lugar", "Medalla de plata", GIN),
    3: ("Tercer lugar", "Medalla de bronce", DOU),
}
MONTHS = (
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
)


# ---------------------------------------------------------------------------
# Permisos (fáciles de extender cuando existan cuentas de competidor y tutores)
# ---------------------------------------------------------------------------


def can_download_person(db: Session, user: User, tid: int, person_id: int) -> bool:
    """Organizador del torneo o la propia persona.

    TODO(cuentas): cuando existan cuentas de competidor con tutor, el tutor
    de un menor también descarga sus diplomas: agregar aquí esa relación.
    """
    if is_organizer(db, user, tid):
        return True
    return user.person_id is not None and user.person_id == person_id


def can_download_dojo(db: Session, user: User, tid: int, dojo_id: int | None) -> bool:
    """Organizador del torneo; con dojo, también su sensei o administrador de dojo."""
    if is_organizer(db, user, tid):
        return True
    if dojo_id is None:
        return False
    return any(
        r.role in ("sensei", "dojo_admin") and r.scope_type == "dojo" and r.scope_id == dojo_id
        for r in roles_of(db, user)
    )


# ---------------------------------------------------------------------------
# Quién compitió y en qué lugar (por lotes)
# ---------------------------------------------------------------------------


@dataclass
class Participation:
    """Una inscripción que compitió en una categoría finalizada."""

    registration: Registration
    category: Category
    place: int | None  # 1, 2, 3… o None (sin puesto)
    fought: bool  # peleó al menos un combate (no solo walkover o bye) o ejecutó su kata


def participations(db: Session, cats: list[Category]) -> list[Participation]:
    """Participaciones de las categorías dadas en cuatro consultas.

    Compitió: tiene puesto, o sigue activa y no fue marcada ausente, o se retiró
    después de pelear algún combate (lesión). Quien «no se presentó» no cuenta.
    """
    if not cats:
        return []
    by_id = {c.id: c for c in cats}
    ids = list(by_id)
    places = {
        rid: place
        for rid, place in db.execute(
            select(CategoryResult.registration_id, CategoryResult.place).where(CategoryResult.category_id.in_(ids))
        ).all()
    }
    fought: set[int] = set()
    for aka, ao, method in db.execute(
        select(Match.aka_registration_id, Match.ao_registration_id, Match.method).where(
            Match.category_id.in_(ids),
            Match.is_current,
            Match.parent_match_id.is_(None),
            Match.status == "finished",
        )
    ).all():
        if method == "walkover":
            continue
        fought.update(x for x in (aka, ao) if x)
    fought.update(
        db.scalars(
            select(KataPerformance.registration_id).where(
                KataPerformance.category_id.in_(ids), KataPerformance.total.is_not(None)
            )
        ).all()
    )
    regs = (
        db.scalars(
            select(Registration)
            .where(Registration.category_id.in_(ids))
            .options(selectinload(Registration.team).selectinload(Team.members).joinedload(TeamMember.person))
            .order_by(Registration.id)
        )
        .unique()
        .all()
    )
    out = []
    for r in regs:
        place = places.get(r.id)
        active = r.status == "active" and r.checkin_status != "absent"
        injured = r.status == "withdrawn" and r.withdrawn_reason != NO_SHOW_REASON and r.id in fought
        if place is None and not active and not injured:
            continue
        out.append(Participation(r, by_id[r.category_id], place, r.id in fought))
    return out


@dataclass
class Diploma:
    name: str
    dojo: str
    category: str
    place: int | None
    team: str = ""


def _people(p: Participation) -> list[tuple[int | None, str]]:
    """Personas que reciben el diploma: la inscrita o cada integrante del equipo."""
    r = p.registration
    if r.team is not None:
        return [(m.person_id, f"{m.person.first_names} {m.person.last_names}") for m in r.team.members]
    if r.person is not None:
        return [(r.person_id, f"{r.person.first_names} {r.person.last_names}")]
    return []


def diplomas_for(
    parts: list[Participation], kind: Kind, person_id: int | None = None, dojo_id: int | None = None
) -> list[Diploma]:
    out = []
    for p in parts:
        podium = p.place is not None and p.place <= 3
        if kind == "podium" and not podium:
            continue
        if kind == "participation" and podium:
            continue
        if dojo_id is not None and p.registration.dojo_id != dojo_id:
            continue
        team = p.registration.team.name if p.registration.team else ""
        for pid, name in _people(p):
            if person_id is not None and pid != person_id:
                continue
            out.append(
                Diploma(
                    name=name,
                    dojo=p.registration.dojo.name if p.registration.dojo else "",
                    category=p.category.name,
                    place=p.place if podium else None,
                    team=team,
                )
            )
    return out


def finished_categories(db: Session, tid: int) -> list[Category]:
    return list(
        db.scalars(
            select(Category)
            .where(Category.tournament_id == tid, Category.status == "finished")
            .order_by(Category.sort_order, Category.id)
        ).all()
    )


def category_diplomas(db: Session, cid: int, kind: Kind) -> tuple[Tournament, list[Diploma]]:
    c = get_category(db, cid)
    if c.status != "finished":
        raise InvalidState("La categoría aún no termina: los diplomas salen con el podio definitivo")
    t = get_tournament(db, c.tournament_id)
    return t, _sorted(diplomas_for(participations(db, [c]), kind))


def tournament_diplomas(
    db: Session, tid: int, kind: Kind, *, dojo_id: int | None = None, person_id: int | None = None
) -> tuple[Tournament, list[Diploma]]:
    t = get_tournament(db, tid)
    parts = participations(db, finished_categories(db, tid))
    return t, _sorted(diplomas_for(parts, kind, person_id=person_id, dojo_id=dojo_id))


def _sorted(items: list[Diploma]) -> list[Diploma]:
    # Primero el podio (oro, plata, bronce), luego participación; dentro, por nombre.
    return sorted(items, key=lambda d: (d.category, d.place or 99, d.name))


def person_certificates(db: Session, person_id: int) -> list[dict[str, Any]]:
    """Torneos con diplomas o certificados de la persona (para su perfil)."""
    team_ids = set(db.scalars(select(TeamMember.team_id).where(TeamMember.person_id == person_id)).all())
    conds = [Registration.person_id == person_id]
    if team_ids:
        conds.append(Registration.team_id.in_(team_ids))
    cat_ids = set(db.scalars(select(Registration.category_id).where(or_(*conds))).all())
    if not cat_ids:
        return []
    cats = list(db.scalars(select(Category).where(Category.id.in_(cat_ids), Category.status == "finished")).all())
    parts = participations(db, cats)
    by_t: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for p in parts:
        if any(pid == person_id for pid, _ in _people(p)):
            podium = p.place if p.place is not None and p.place <= 3 else None
            by_t[p.category.tournament_id].append(
                {"category_id": p.category.id, "category_name": p.category.name, "place": podium}
            )
    if not by_t:
        return []
    ts = {t.id: t for t in db.scalars(select(Tournament).where(Tournament.id.in_(list(by_t)))).all()}
    return sorted(
        (
            {
                "tournament_id": tid,
                "tournament_name": ts[tid].name,
                "start_date": ts[tid].start_date,
                "is_test": ts[tid].is_test,
                "items": sorted(items, key=lambda x: (x["place"] or 99, x["category_name"])),
            }
            for tid, items in by_t.items()
        ),
        key=lambda x: x["start_date"],
        reverse=True,
    )


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------


def date_text(start: date, end: date | None = None) -> str:
    """«17 de octubre de 2026» o «del 17 al 18 de octubre de 2026»."""
    if end is None or end == start:
        return f"{start.day} de {MONTHS[start.month - 1]} de {start.year}"
    if (start.year, start.month) == (end.year, end.month):
        return f"del {start.day} al {end.day} de {MONTHS[end.month - 1]} de {end.year}"
    return f"del {date_text(start)} al {date_text(end)}"


def _fit(pdf: canvas.Canvas, text: str, font: str, size: float, max_w: float) -> float:
    """Tamaño de letra que hace caber el texto en ``max_w`` (nombres largos)."""
    while size > 10 and pdf.stringWidth(text, font, size) > max_w:
        size -= 1
    return size


def _draw_diploma(pdf: canvas.Canvas, t: Tournament, d: Diploma, W: float, H: float) -> None:
    accent = PLACE[d.place][2] if d.place in PLACE else AI
    # Marco doble: tinta sumi afuera, color del lugar adentro.
    pdf.setStrokeColor(SUMI)
    pdf.setLineWidth(2)
    pdf.rect(24, 24, W - 48, H - 48)
    pdf.setStrokeColor(accent)
    pdf.setLineWidth(5)
    pdf.rect(34, 34, W - 68, H - 68)
    pdf.setStrokeColor(KASUMI)
    pdf.setLineWidth(0.8)
    pdf.rect(44, 44, W - 88, H - 88)

    cx = W / 2
    _enso(pdf, cx, H - 92, 22)
    pdf.setFillColor(NEZUMI)
    pdf.setFont("Helvetica", 8)
    pdf.drawCentredString(cx, H - 130, "H A J I M E   ·   T O R N E O S   D E   K A R A T E")

    title = "Diploma" if d.place in PLACE else "Certificado de participación"
    pdf.setFillColor(SUMI)
    pdf.setFont("Times-Bold", 40 if d.place in PLACE else 32)
    pdf.drawCentredString(cx, H - 178, title)

    pdf.setFont("Times-Italic", 15)
    pdf.setFillColor(USUZUMI)
    pdf.drawCentredString(cx, H - 214, "Se otorga a")
    size = _fit(pdf, d.name, "Times-Bold", 34, W - 180)
    pdf.setFont("Times-Bold", size)
    pdf.setFillColor(SUMI)
    pdf.drawCentredString(cx, H - 256, d.name)
    pdf.setStrokeColor(KASUMI)
    pdf.setLineWidth(0.8)
    pdf.line(cx - 220, H - 266, cx + 220, H - 266)
    pdf.setFont("Helvetica", 10)
    pdf.setFillColor(USUZUMI)
    who = d.dojo + (f" · Equipo {d.team}" if d.team else "")
    pdf.drawCentredString(cx, H - 282, who[:110])

    y = H - 318
    if d.place in PLACE:
        label, medal, color = PLACE[d.place]
        pdf.setFillColor(color)
        pdf.setFont("Times-Bold", 20)
        pdf.drawCentredString(cx, y, f"{label} — {medal}")
        y -= 26
        lead = "en la categoría"
    else:
        lead = "por su participación en la categoría"
    pdf.setFillColor(SUMI)
    pdf.setFont("Times-Roman", 14)
    pdf.drawCentredString(cx, y, lead)
    y -= 20
    pdf.setFont("Times-Bold", _fit(pdf, d.category, "Times-Bold", 16, W - 180))
    pdf.drawCentredString(cx, y, d.category)
    y -= 26
    pdf.setFont("Times-Roman", 13)
    place_txt = f"realizado en {t.city}, " if t.city else ""
    line = f"del torneo «{t.name}», {place_txt}{date_text(t.start_date, t.end_date)}."
    pdf.setFont("Times-Roman", _fit(pdf, line, "Times-Roman", 13, W - 160))
    pdf.drawCentredString(cx, y, line)

    # Organizador (izquierda) y firma (derecha).
    base = 92
    if t.certificate_organizer:
        pdf.setFont("Helvetica", 8)
        pdf.setFillColor(NEZUMI)
        pdf.drawCentredString(W * 0.28, base + 18, "ORGANIZA")
        pdf.setFont("Times-Bold", 12)
        pdf.setFillColor(SUMI)
        pdf.drawCentredString(W * 0.28, base, t.certificate_organizer[:60])
    pdf.setStrokeColor(SUMI)
    pdf.setLineWidth(0.8)
    pdf.line(W * 0.62, base + 12, W * 0.86, base + 12)
    pdf.setFillColor(SUMI)
    pdf.setFont("Times-Bold", 12)
    pdf.drawCentredString(W * 0.74, base - 4, (t.certificate_signer_name or " ")[:60])
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(USUZUMI)
    pdf.drawCentredString(W * 0.74, base - 17, (t.certificate_signer_title or "")[:70])

    if t.is_test:
        pdf.saveState()
        pdf.setFillColor(SHU)
        pdf.setFont("Helvetica-Bold", 11)
        pdf.drawCentredString(cx, 54, "TORNEO DE PRUEBA — SIN VALIDEZ OFICIAL")
        pdf.restoreState()


def diplomas_pdf(t: Tournament, items: list[Diploma], title: str) -> bytes:
    buf = io.BytesIO()
    page = landscape(A4)
    pdf = canvas.Canvas(buf, pagesize=page)
    pdf.setTitle(title)
    pdf.setAuthor(t.certificate_organizer or "Hajime")
    W, H = page
    if not items:
        pdf.setFont("Helvetica", 12)
        pdf.drawString(60, H - 80, "No hay diplomas para esta selección: solo salen de categorías finalizadas.")
        pdf.showPage()
    for d in items:
        _draw_diploma(pdf, t, d, W, H)
        pdf.showPage()
    pdf.save()
    return buf.getvalue()
