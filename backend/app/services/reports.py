"""Resultados, medallero, reporte de comparación (Shadow Mode) y exportaciones
(sección 21). Las agregaciones son candidatas a stored procedures en SQL Server
cuando el volumen lo justifique; hoy se resuelven en Python sin cambiar la API.
"""

from __future__ import annotations

import io
from collections import defaultdict
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Font
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas as s
from app.api.errors import NotFound
from app.db.models import Category, CategoryResult, Dojo, Match, Registration, ShadowComparison, Tournament
from app.services.audit import audit
from app.services.brackets import REG_LIGHT, bracket_out, get_match
from app.services.tournaments import get_tournament

PLACE_LABEL = {1: "Oro", 2: "Plata", 3: "Bronce"}

# Paleta «Dō» (docs/diseno.md): pigmentos tradicionales, igual que la interfaz.
SHU = colors.HexColor("#B8322A")  # aka
AI = colors.HexColor("#24477A")  # ao
SUMI = colors.HexColor("#1E1C1A")
USUZUMI = colors.HexColor("#4A463F")
NEZUMI = colors.HexColor("#8A8377")
KASUMI = colors.HexColor("#E3DBCB")
LOGO_AKA = colors.HexColor("#BE3B2C")
LOGO_AO = colors.HexColor("#24477A")


def _enso(pdf: canvas.Canvas, cx: float, cy: float, r: float) -> None:
    """Ensō de la marca en papel: trazo aka (shu) a la izquierda y ao (ai) a la derecha (docs/marca)."""
    pdf.saveState()
    pdf.setLineCap(1)
    pdf.setLineWidth(r * 0.42)
    pdf.setStrokeColor(LOGO_AKA)
    pdf.arc(cx - r, cy - r, cx + r, cy + r, startAng=104, extent=154)
    pdf.setStrokeColor(LOGO_AO)
    pdf.arc(cx - r, cy - r, cx + r, cy + r, startAng=-98, extent=150)
    pdf.restoreState()


def _cell(v):
    """Evita que un nombre como "=HYPERLINK(...)" se interprete como fórmula en Excel."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def category_results(db: Session, tid: int) -> list[dict[str, Any]]:
    """Podio de cada categoría del torneo con dos consultas (antes, una por categoría)."""
    cats = db.scalars(
        select(Category).where(Category.tournament_id == tid).order_by(Category.sort_order, Category.id)
    ).all()
    by_cat: dict[int, list[tuple[CategoryResult, Registration]]] = defaultdict(list)
    for res, reg in db.execute(
        select(CategoryResult, Registration)
        .join(Registration, Registration.id == CategoryResult.registration_id)
        .join(Category, Category.id == CategoryResult.category_id)
        .where(Category.tournament_id == tid)
        .order_by(CategoryResult.place, CategoryResult.id)
        .options(*REG_LIGHT)
    ).all():
        by_cat[res.category_id].append((res, reg))
    out = []
    for c in cats:
        rows = by_cat[c.id]
        out.append(
            {
                "category_id": c.id,
                "category_name": c.name,
                "status": c.status,
                "merged_into_id": c.merged_into_id,
                "places": [
                    {
                        "place": res.place,
                        "registration_id": reg.id,
                        "name": reg.display_name,
                        "dojo_id": reg.dojo_id,
                        "dojo_name": reg.dojo.name,
                    }
                    for res, reg in rows
                ],
            }
        )
    return out


def medal_table(db: Session, tid: int) -> dict[str, Any]:
    t = get_tournament(db, tid)
    rows = db.execute(
        select(CategoryResult.place, Registration.dojo_id)
        .join(Registration, Registration.id == CategoryResult.registration_id)
        .join(Category, Category.id == CategoryResult.category_id)
        .where(Category.tournament_id == tid, Category.status == "finished")
    ).all()
    tally: dict[int, list[int]] = defaultdict(lambda: [0, 0, 0])
    for place, dojo_id in rows:
        if place in (1, 2, 3):
            tally[dojo_id][place - 1] += 1
    dojos = {d.id: d.name for d in db.scalars(select(Dojo).where(Dojo.id.in_(list(tally)))).all()} if tally else {}
    return {"tournament_id": tid, "is_test": t.is_test, "rows": rank_medals(tally, dojos)}


def rank_medals(tally: dict[int, list[int]], dojo_names: dict[int, str]) -> list[dict[str, Any]]:
    """Medallero ordenado (oro, plata, bronce) con puesto compartido en empate.
    ``tally``: dojo → [oros, platas, bronces]. Sin consultas: el vivo lo usa con
    los resultados que ya cargó."""
    table = sorted(
        (
            {
                "dojo_id": did,
                "dojo_name": dojo_names[did],
                "gold": g,
                "silver": sv,
                "bronze": b,
                "total": g + sv + b,
            }
            for did, (g, sv, b) in tally.items()
        ),
        key=lambda r: (-r["gold"], -r["silver"], -r["bronze"], r["dojo_name"]),
    )
    rank = 0
    prev = None
    for i, r in enumerate(table):
        k = (r["gold"], r["silver"], r["bronze"])
        if k != prev:
            rank = i + 1
        r["rank"] = rank
        prev = k
    return table


# ---------------------------------------------------------------------------
# Shadow Mode
# ---------------------------------------------------------------------------


def set_official_result(db: Session, user, mid: int, data: s.OfficialResultIn) -> ShadowComparison:
    m = get_match(db, mid)
    sc = db.scalar(select(ShadowComparison).where(ShadowComparison.match_id == mid))
    if sc is None:
        sc = ShadowComparison(match_id=mid)
        db.add(sc)
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(sc, k, v)
    sc.updated_by_id = user.id
    c = db.get(Category, m.category_id)
    audit(
        db, user, "match", mid, "official_result", after=data.model_dump(), tournament_id=c.tournament_id if c else None
    )
    db.commit()
    return sc


def comparison_report(db: Session, tid: int) -> dict[str, Any]:
    rows = db.execute(
        select(Match, Category)
        .join(Category, Category.id == Match.category_id)
        .where(
            Category.tournament_id == tid,
            Match.is_current,
            Match.parent_match_id.is_(None),
            Match.status.in_(("finished", "needs_review")),
        )
        .order_by(Category.id, Match.round, Match.position)
    ).all()
    comps = {
        sc.match_id: sc
        for sc in db.scalars(
            select(ShadowComparison).where(ShadowComparison.match_id.in_([m.id for m, _ in rows] or [0]))
        ).all()
    }
    items = []
    compared = equal = 0
    for m, c in rows:
        sc = comps.get(m.id)
        winner_match = score_match = None
        if sc and sc.official_winner_registration_id is not None:
            compared += 1
            winner_match = sc.official_winner_registration_id == m.winner_registration_id
            equal += int(winner_match)
        if sc and sc.official_aka_score is not None and sc.official_ao_score is not None:
            score_match = (sc.official_aka_score, sc.official_ao_score) == (m.aka_score, m.ao_score)
        items.append(
            {
                "match_id": m.id,
                "category_id": c.id,
                "category_name": c.name,
                "code": m.code,
                "app_winner_registration_id": m.winner_registration_id,
                "app_score": [m.aka_score, m.ao_score],
                "official_winner_registration_id": sc.official_winner_registration_id if sc else None,
                "official_score": [sc.official_aka_score, sc.official_ao_score] if sc else [None, None],
                "winner_matches": winner_match,
                "score_matches": score_match,
                "finding": sc.finding if sc else None,
                "error_source": sc.error_source if sc else None,
            }
        )
    return {
        "tournament_id": tid,
        "matches": len(items),
        "compared": compared,
        "winner_agreement_pct": round(100 * equal / compared, 1) if compared else None,
        "differences": [i for i in items if i["winner_matches"] is False or i["score_matches"] is False],
        "items": items,
    }


# ---------------------------------------------------------------------------
# PDF de llave
# ---------------------------------------------------------------------------


def bracket_pdf(db: Session, cid: int, with_results: bool = True) -> bytes:
    c = db.get(Category, cid)
    t = db.get(Tournament, c.tournament_id) if c else None
    buf = io.BytesIO()
    page = landscape(A4)
    pdf = canvas.Canvas(buf, pagesize=page)
    pdf.setTitle(f"Llave {c.code if c else ''} - {c.name if c else cid}")
    _draw_bracket_page(pdf, bracket_out(db, cid), c, t, page, with_results, _match_numbers(db, c))
    pdf.save()
    return buf.getvalue()


def brackets_pdf(db: Session, tid: int, with_results: bool = True) -> bytes:
    """Todas las llaves del torneo en un solo PDF, una página por categoría,
    en el orden en que se compiten: por tatami y por su cola; al final las
    categorías sin tatami. Las categorías sin llave no aparecen."""
    from app.services.brackets import queue_order

    t = get_tournament(db, tid)
    tatami_pos = {tat.id: tat.number for tat in t.tatamis}
    cats = queue_order(list(db.scalars(select(Category).where(Category.tournament_id == tid)).all()))
    cats.sort(key=lambda c: tatami_pos.get(c.tatami_id, 10**6))
    buf = io.BytesIO()
    page = landscape(A4)
    pdf = canvas.Canvas(buf, pagesize=page)
    pdf.setTitle(f"Llaves - {t.name}")
    pages = 0
    for c in cats:
        if c.status in ("cancelled", "merged"):
            continue
        try:
            b = bracket_out(db, c.id)
        except NotFound:
            continue
        if len(b.participants) < 2:
            # Un solo inscrito (campeón sin pelear) o llave vacía: nada que imprimir.
            continue
        _draw_bracket_page(pdf, b, c, t, page, with_results, _match_numbers(db, c))
        pages += 1
    if not pages:
        pdf.setFont("Helvetica", 12)
        pdf.drawString(40, page[1] - 60, f"{t.name}: todavía no hay llaves generadas")
        pdf.showPage()
    pdf.save()
    return buf.getvalue()


FORMAT_LABEL = {
    "single_elimination": "Eliminación directa",
    "round_robin": "Todos contra todos",
    "groups_knockout": "Grupos y eliminación",
    "kata_rounds": "Kata por rondas",
}
THIRD_LABEL = {
    "two_bronzes": "dos bronces",
    "third_place_match": "combate por el 3.er puesto",
    "repechage": "repechaje",
}


def _match_numbers(db: Session, c: Category | None) -> dict[int, str]:
    """Número de cada combate en la planilla del tatami (T1-005…), si la categoría tiene tatami."""
    if c is None or not c.tatami_id:
        return {}
    from app.services.brackets import tatami_schedule

    try:
        items = tatami_schedule(db, c.tatami_id)["items"]
    except Exception:  # noqa: BLE001 — el número es un apoyo; la llave se imprime igual
        return {}
    return {it["match"].id: it["number"] for it in items if it["match"].category_id == c.id}


def _draw_bracket_page(
    pdf: canvas.Canvas,
    b: s.BracketOut,
    c: Category | None,
    t: Tournament | None,
    page: tuple[float, float],
    with_results: bool,
    numbers: dict[int, str] | None = None,
) -> None:
    """Una llave en una página apaisada: cabecera con el código de la categoría
    (A7, B12…), datos del torneo y el cuadro; al pie, versión y semilla."""
    W, H = page
    left, right = 30, W - 30
    code = (c.code if c else "").strip()
    # Cabecera: código en recuadro, nombre de la categoría y torneo.
    pdf.saveState()
    pdf.setFillColor(SHU if (c and c.modality == "kumite") else AI)
    pdf.roundRect(left, H - 58, 62, 34, 4, stroke=0, fill=1)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 20 if len(code) <= 3 else 14)
    pdf.drawCentredString(left + 31, H - 47, code or "—")
    pdf.restoreState()
    pdf.setFillColor(SUMI)
    pdf.setFont("Helvetica-Bold", 15)
    pdf.drawString(left + 72, H - 40, (c.name if c else "")[:70])
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(USUZUMI)
    partes = []
    if t:
        partes.append(t.name)
        if t.start_date:
            partes.append(t.start_date.strftime("%d/%m/%Y"))
    if c and c.tatami_id and t:
        tat = next((x for x in t.tatamis if x.id == c.tatami_id), None)
        if tat:
            partes.append(tat.name)
    partes.append(f"{len(b.participants)} competidores")
    fmt = FORMAT_LABEL.get(b.format, b.format)
    if b.format == "single_elimination" and b.third_place_rule in THIRD_LABEL:
        fmt += f" · {THIRD_LABEL[b.third_place_rule]}"
    partes.append(fmt)
    pdf.drawString(left + 72, H - 54, "  ·  ".join(partes)[:160])
    _enso(pdf, right - 10, H - 42, 9)
    pdf.setStrokeColor(KASUMI)
    pdf.setLineWidth(1)
    pdf.line(left, H - 66, right, H - 66)

    def pname(rid: int | None) -> str:
        if rid is None:
            return ""
        p = b.participants.get(rid)
        return p.name if p else str(rid)

    def pdojo(rid: int | None) -> str:
        p = b.participants.get(rid) if rid is not None else None
        return _short_dojo(p.dojo_name) if p else ""

    if b.format == "single_elimination":
        _draw_elimination(pdf, b, W, H, pname, with_results, pdojo=pdojo, numbers=numbers or {})
    else:
        _draw_list(pdf, b, H, lambda rid: f"{pname(rid)} ({pdojo(rid)})" if rid else "", with_results)
    # Pie: trazabilidad de la versión impresa.
    pdf.setFont("Helvetica", 7)
    pdf.setFillColor(NEZUMI)
    pdf.drawString(left, 22, f"Llave versión {b.version_number} · semilla {b.seed} · Hajime")
    pdf.drawRightString(right, 22, "AKA = rojo (arriba) · AO = azul (abajo)")
    pdf.setFillColor(colors.black)
    pdf.showPage()


def _short_dojo(name: str) -> str:
    """«Kento Kai - San Miguel» → «KK San Miguel»: cabe en el recuadro sin perder la sede."""
    name = (name or "").strip()
    if " - " in name:
        head, tail = name.split(" - ", 1)
        initials = "".join(w[0] for w in head.split() if w[:1].isalpha()).upper()
        return f"{initials} {tail}" if initials else tail
    return name


def _draw_elimination(
    pdf: canvas.Canvas,
    b: s.BracketOut,
    W: float,
    H: float,
    pname,
    with_results: bool,
    pdojo=lambda rid: "",
    numbers: dict[int, str] | None = None,
) -> None:
    """Cuadro clásico de torneo: cada competidor en un recuadro (franja roja
    AKA arriba, azul AO abajo), líneas de avance hacia la derecha, número de
    combate de la planilla y recuadro de campeón al final."""
    numbers = numbers or {}
    main = [m for m in b.matches if m.kind == "main"]
    rounds = max((m.round for m in main), default=0)
    extras = [m for m in b.matches if m.kind != "main"]
    top, bottom, left, right = H - 80, 50 + (14 * len(extras) + 16 if extras else 0), 30, W - 30
    gap = 28  # separación horizontal entre rondas
    col_w = min(250, (right - left - 90) / max(rounds, 1))  # 90 pt reservados al recuadro del campeón
    box_w = col_w - gap
    first = sorted((m for m in main if m.round == 1), key=lambda m: m.position)
    # Cuadros chicos (2 a 4 competidores): recuadros juntos arriba, no repartidos por toda la hoja.
    slot_h = min(44, (top - bottom) / max(len(first) * 2, 1))
    box_h = min(26, slot_h - 3)
    two_lines = box_h >= 18
    font = 8 if slot_h >= 20 else 7
    y_of: dict[str, float] = {}

    def box(x: float, yc: float, rid: int | None, side: str, bye: bool, seed: int | None) -> None:
        """Recuadro de un competidor centrado en yc."""
        y0 = yc - box_h / 2
        pdf.setStrokeColor(KASUMI if bye else USUZUMI)
        pdf.setLineWidth(0.8)
        pdf.setFillColor(colors.white)
        pdf.rect(x, y0, box_w, box_h, stroke=1, fill=1)
        if not bye:
            pdf.setFillColor(SHU if side == "aka" else AI)
            pdf.rect(x, y0, 4, box_h, stroke=0, fill=1)
        name = pname(rid)
        if bye:
            pdf.setFillColor(NEZUMI)
            pdf.setFont("Helvetica-Oblique", font)
            pdf.drawString(x + 8, yc - font / 2 + 1, "BYE (pasa directo)" if name == "" else name)
            return
        pdf.setFillColor(SUMI)
        if seed is not None:
            pdf.setFont("Helvetica", font - 1)
            pdf.setFillColor(NEZUMI)
            pdf.drawRightString(x - 3, yc - 2, str(seed))
            pdf.setFillColor(SUMI)
        pdf.setFont("Helvetica-Bold", font)
        maxc = int(box_w / (font * 0.52))
        if two_lines and name:
            pdf.drawString(x + 8, yc + 1.5, name[:maxc])
            pdf.setFont("Helvetica", font - 1.5)
            pdf.setFillColor(USUZUMI)
            pdf.drawString(x + 8, yc - font + 1, pdojo(rid)[:maxc])
        elif name:
            pdf.drawString(x + 8, yc - font / 2 + 1, f"{name} · {pdojo(rid)}"[:maxc])
        pdf.setFillColor(colors.black)

    seed_no = 0
    labels: list[tuple[float, float, str, Any]] = []
    for r in range(1, rounds + 1):
        x = left + 10 + (r - 1) * col_w
        for m in sorted((m for m in main if m.round == r), key=lambda m: m.position):
            if r == 1:
                ya = top - (2 * m.position + 0.5) * slot_h
                yb = top - (2 * m.position + 1.5) * slot_h
            else:
                ya = y_of[f"R{r - 1}-{2 * m.position + 1}"]
                yb = y_of[f"R{r - 1}-{2 * m.position + 2}"]
            mid = (ya + yb) / 2
            y_of[m.code] = mid
            show = with_results or r == 1
            bye = m.status == "bye"
            a_id = m.aka_registration_id if show else None
            o_id = m.ao_registration_id if show else None
            sa = so = None
            if r == 1:
                seed_no += 1
                sa = seed_no
                seed_no += 1
                so = seed_no
            box(x, ya, a_id, "aka", bye and a_id is None, sa)
            box(x, yb, o_id, "ao", bye and o_id is None, so)
            # Conectores: de cada recuadro a la columna de unión y de ahí al siguiente.
            xj = x + box_w + gap / 2
            pdf.setStrokeColor(USUZUMI)
            pdf.setLineWidth(0.8)
            pdf.line(x + box_w, ya, xj, ya)
            pdf.line(x + box_w, yb, xj, yb)
            pdf.line(xj, ya, xj, yb)
            pdf.line(xj, mid, x + col_w, mid)
            if not bye:
                labels.append((xj, mid, numbers.get(m.id, m.code), m))
    # Resultado del combate (solo con resultados): marcador sobre la línea de avance.
    if with_results:
        for xj, mid, _label, m in labels:
            if m.status == "finished" and m.aka_score is not None:
                pdf.setFont("Helvetica-Bold", 7)
                pdf.setFillColor(SUMI)
                pdf.drawCentredString(xj, mid + 3, f"{m.aka_score}-{m.ao_score}")
    pdf.setFillColor(colors.black)
    # Campeón.
    final = next((m for m in main if m.round == rounds), None)
    if final:
        x = left + 10 + rounds * col_w
        yc = y_of[final.code]
        champ_w = min(200, right - x)
        pdf.setStrokeColor(SUMI)
        pdf.setLineWidth(1.2)
        pdf.setFillColor(colors.HexColor("#FBF6EA"))
        pdf.rect(x, yc - box_h / 2, champ_w, box_h, stroke=1, fill=1)
        pdf.setFont("Helvetica", 6.5)
        pdf.setFillColor(NEZUMI)
        pdf.drawString(x + 4, yc + box_h / 2 + 3, "CAMPEÓN")
        if with_results and final.winner_registration_id:
            pdf.setFont("Helvetica-Bold", font)
            pdf.setFillColor(SUMI)
            pdf.drawString(
                x + 5, yc - font / 2 + 1, pname(final.winner_registration_id)[: int(champ_w / (font * 0.52))]
            )
        pdf.setFillColor(colors.black)
    # Terceros puestos / repechaje.
    if extras:
        y = bottom - 14
        pdf.setFont("Helvetica-Bold", 8)
        pdf.setFillColor(SUMI)
        pdf.drawString(left, y, "Otros combates")
        pdf.setFont("Helvetica", 8)
        for m in extras:
            y -= 12
            label = "3.er puesto" if m.kind == "third_place" else f"Repechaje {m.code}"
            aka = pname(m.aka_registration_id) or "(por definir)"
            ao = pname(m.ao_registration_id) or "(por definir)"
            txt = f"{label}: {aka} vs {ao}"
            if with_results and m.winner_registration_id:
                txt += f" → {pname(m.winner_registration_id)}"
            pdf.setFillColor(USUZUMI)
            pdf.drawString(left, y, txt[:160])
        pdf.setFillColor(colors.black)


def _draw_list(pdf: canvas.Canvas, b: s.BracketOut, H: float, pname, with_results: bool) -> None:
    y = H - 70
    pdf.setFont("Helvetica", 9)
    if b.format == "kata_rounds":
        pdf.drawString(30, y, "Orden de ejecución")
        y -= 14
        for row in b.standings or []:
            line = f"{row['order']:>2}. {pname(row['registration_id'])}"
            if with_results and row.get("total") is not None:
                line += f"   total {row['total']:.1f}   puesto {row['rank']}"
            pdf.drawString(40, y, line)
            y -= 13
        return
    for m in b.matches:
        line = f"{m.code}: {pname(m.aka_registration_id)}  vs  {pname(m.ao_registration_id)}"
        if with_results and m.winner_registration_id:
            line += f"   → {pname(m.winner_registration_id)} ({m.aka_score}-{m.ao_score})"
        pdf.drawString(30, y, line[:160])
        y -= 13
        if y < 40:
            pdf.showPage()
            pdf.setFont("Helvetica", 9)
            y = H - 40


# ---------------------------------------------------------------------------
# Excel de resultados y medallero
# ---------------------------------------------------------------------------


def results_excel(db: Session, tid: int) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Resultados"
    ws.append(["Categoría", "Puesto", "Competidor", "Dojo"])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for cat in category_results(db, tid):
        for p in cat["places"]:
            ws.append(
                [
                    _cell(cat["category_name"]),
                    PLACE_LABEL.get(p["place"], p["place"]),
                    _cell(p["name"]),
                    _cell(p["dojo_name"]),
                ]
            )
    mt = wb.create_sheet("Medallero")
    mt.append(["Puesto", "Dojo", "Oro", "Plata", "Bronce", "Total"])
    for cell in mt[1]:
        cell.font = Font(bold=True)
    for r in medal_table(db, tid)["rows"]:
        mt.append([r["rank"], _cell(r["dojo_name"]), r["gold"], r["silver"], r["bronze"], r["total"]])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def results_pdf(db: Session, tid: int) -> bytes:
    t = get_tournament(db, tid)
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=A4)
    W, H = A4
    y = H - 40
    pdf.setFont("Helvetica-Bold", 14)
    _enso(pdf, 48, y + 4, 8)
    pdf.drawString(64, y, f"Resultados — {t.name}" + (" (PRUEBA)" if t.is_test else ""))
    y -= 24

    def line(txt: str, bold: bool = False, indent: int = 0) -> None:
        nonlocal y
        if y < 50:
            pdf.showPage()
            y = H - 40
        pdf.setFont("Helvetica-Bold" if bold else "Helvetica", 10)
        pdf.drawString(40 + indent, y, txt[:110])
        y -= 14

    line("Medallero por dojo", bold=True)
    for r in medal_table(db, tid)["rows"]:
        line(f"{r['rank']}. {r['dojo_name']}: {r['gold']} oro, {r['silver']} plata, {r['bronze']} bronce", indent=10)
    y -= 8
    for cat in category_results(db, tid):
        if not cat["places"]:
            continue
        line(cat["category_name"], bold=True)
        for p in cat["places"]:
            line(f"{PLACE_LABEL.get(p['place'], p['place'])}: {p['name']} ({p['dojo_name']})", indent=10)
    pdf.showPage()
    pdf.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Planilla de mesa (Shadow Mode)
# ---------------------------------------------------------------------------


def scoresheet_pdf(db: Session, tatami_id: int, with_results: bool = False) -> bytes:
    """Planilla imprimible por tatami: combates en orden con su número (T1-001),
    y casillas en blanco para el marcador y el ganador oficiales. Es lo que la
    mesa oficial llena a mano; luego se compara en el reporte de Shadow Mode.
    """
    from app.services.brackets import participants, tatami_schedule

    sched = tatami_schedule(db, tatami_id)
    tat = sched["tatami"]
    t = db.get(Tournament, tat.tournament_id)
    ids = {x for it in sched["items"] for x in (it["match"].aka_registration_id, it["match"].ao_registration_id) if x}
    parts = participants(db, ids)

    def who(rid, source: str) -> tuple[str, str]:
        if rid and rid in parts:
            p = parts[rid]
            return p.name, p.dojo_name
        kind, _, ref = source.partition(":")
        return {"winner": f"Ganador {ref}", "loser": f"Perdedor {ref}"}.get(kind, ""), ""

    buf = io.BytesIO()
    page = landscape(A4)
    pdf = canvas.Canvas(buf, pagesize=page)
    W, H = page
    pdf.setTitle(f"Planilla {tat.name}")
    cols = [
        ("N.°", 30, 52),
        ("Categoría / combate", 82, 180),
        ("AKA (rojo)", 262, 190),
        ("AO (azul)", 452, 190),
        ("Marcador", 642, 70),
        ("Ganador", 712, 60),
        ("Obs.", 772, 45),
    ]

    def header(y: float) -> float:
        pdf.setFont("Helvetica-Bold", 13)
        _enso(pdf, 38, H - 26, 8)
        pdf.drawString(54, H - 30, f"{t.name if t else ''} — Planilla de mesa {tat.name}")
        pdf.setFont("Helvetica", 8)
        pdf.drawString(
            30,
            H - 43,
            "Registro oficial en papel. Anotar marcador final y marcar ganador. "
            "El número N.° es el mismo que muestra la app.",
        )
        pdf.setFont("Helvetica-Bold", 8)
        for label, x, _w in cols:
            pdf.drawString(x, y, label)
        pdf.line(28, y - 4, W - 28, y - 4)
        return y - 20

    y = header(H - 64)
    row_h = 26
    for it in sched["items"]:
        if y < 40:
            pdf.showPage()
            y = header(H - 64)
        m = it["match"]
        pdf.setFont("Helvetica-Bold", 9)
        pdf.drawString(30, y, it["number"])
        pdf.setFont("Helvetica", 7)
        pdf.drawString(82, y + 4, it["category_name"][:42])
        pdf.drawString(82, y - 5, f"Combate {m.code}")
        for (name, dojo), x, color in (
            (who(m.aka_registration_id, m.aka_source), 262, SHU),
            (who(m.ao_registration_id, m.ao_source), 452, AI),
        ):
            pdf.setFillColor(color)
            pdf.setFont("Helvetica-Bold" if dojo else "Helvetica-Oblique", 8)
            pdf.drawString(x, y + 3, name[:40])
            if dojo:
                pdf.setFont("Helvetica", 6.5)
                pdf.setFillColor(USUZUMI)
                pdf.drawString(x, y - 6, dojo[:52])
        pdf.setFillColor(colors.black)
        pdf.setFont("Helvetica", 8)
        if with_results and m.status == "finished":
            pdf.drawString(642, y, f"{m.aka_score} - {m.ao_score}")
            pdf.drawString(712, y, "AKA" if m.winner_registration_id == m.aka_registration_id else "AO")
        else:
            pdf.drawString(642, y, "____ - ____")
            pdf.rect(712, y - 1, 7, 7)
            pdf.drawString(721, y, "AKA")
            pdf.rect(742, y - 1, 7, 7)
            pdf.drawString(751, y, "AO")
        pdf.setStrokeColor(KASUMI)
        pdf.line(28, y - 11, W - 28, y - 11)
        pdf.setStrokeColor(colors.black)
        y -= row_h
    if not sched["items"]:
        pdf.setFont("Helvetica", 10)
        pdf.drawString(30, y, "No hay combates: asigna categorías con llave a este tatami.")
    pdf.showPage()
    pdf.save()
    return buf.getvalue()
