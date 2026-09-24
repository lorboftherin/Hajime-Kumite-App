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
from app.db.models import Category, CategoryResult, Dojo, Match, Registration, ShadowComparison, Tournament
from app.services.audit import audit
from app.services.brackets import bracket_out, get_match
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
    cats = db.scalars(
        select(Category).where(Category.tournament_id == tid).order_by(Category.sort_order, Category.id)
    ).all()
    out = []
    for c in cats:
        rows = db.execute(
            select(CategoryResult, Registration)
            .join(Registration, Registration.id == CategoryResult.registration_id)
            .where(CategoryResult.category_id == c.id)
            .order_by(CategoryResult.place)
        ).all()
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
    dojos = {d.id: d for d in db.scalars(select(Dojo).where(Dojo.id.in_(list(tally)))).all()} if tally else {}
    table = sorted(
        (
            {
                "dojo_id": did,
                "dojo_name": dojos[did].name,
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
    return {"tournament_id": tid, "is_test": t.is_test, "rows": table}


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
            Match.is_current.is_(True),
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
    b = bracket_out(db, cid)
    c = db.get(Category, cid)
    t = db.get(Tournament, c.tournament_id) if c else None
    buf = io.BytesIO()
    page = landscape(A4)
    pdf = canvas.Canvas(buf, pagesize=page)
    W, H = page
    pdf.setTitle(f"Llave - {c.name if c else cid}")
    pdf.setFont("Helvetica-Bold", 14)
    _enso(pdf, 38, H - 26, 8)
    pdf.drawString(54, H - 30, f"{t.name if t else ''} — {c.name if c else ''}")
    pdf.setFont("Helvetica", 8)
    pdf.drawString(30, H - 44, f"Versión {b.version_number} · semilla {b.seed} · formato {b.format}")

    def pname(rid: int | None) -> str:
        if rid is None:
            return ""
        p = b.participants.get(rid)
        return f"{p.name} ({p.dojo_name})" if p else str(rid)

    if b.format == "single_elimination":
        _draw_elimination(pdf, b, W, H, pname, with_results)
    else:
        _draw_list(pdf, b, H, pname, with_results)
    pdf.showPage()
    pdf.save()
    return buf.getvalue()


def _draw_elimination(pdf: canvas.Canvas, b: s.BracketOut, W: float, H: float, pname, with_results: bool) -> None:
    main = [m for m in b.matches if m.kind == "main"]
    rounds = max((m.round for m in main), default=0)
    top, bottom, left = H - 70, 60, 30
    col_w = min(190, (W - 2 * left) / max(rounds + 1, 1))
    first = sorted((m for m in main if m.round == 1), key=lambda m: m.position)
    slot_h = (top - bottom) / max(len(first) * 2, 1)
    y_of: dict[str, float] = {}
    font = 7 if len(first) > 8 else 8
    pdf.setFont("Helvetica", font)
    for r in range(1, rounds + 1):
        x = left + (r - 1) * col_w
        for m in sorted((m for m in main if m.round == r), key=lambda m: m.position):
            if r == 1:
                ya = top - (2 * m.position + 0.5) * slot_h
                yb = top - (2 * m.position + 1.5) * slot_h
            else:
                ya = y_of[f"R{r - 1}-{2 * m.position + 1}"]
                yb = y_of[f"R{r - 1}-{2 * m.position + 2}"]
            mid = (ya + yb) / 2
            y_of[m.code] = mid
            pdf.setStrokeColor(colors.black)
            pdf.line(x, ya, x + col_w - 10, ya)
            pdf.line(x, yb, x + col_w - 10, yb)
            pdf.line(x + col_w - 10, ya, x + col_w - 10, yb)
            show = with_results or r == 1
            a = pname(m.aka_registration_id) if show else ""
            o = pname(m.ao_registration_id) if show else ""
            if r == 1 and m.status == "bye":
                a = a or "— bye —"
                o = o or "— bye —"
            pdf.setFillColor(SHU)
            pdf.drawString(x + 2, ya + 2, a[:40])
            pdf.setFillColor(AI)
            pdf.drawString(x + 2, yb + 2, o[:40])
            pdf.setFillColor(colors.black)
            if with_results and m.status == "finished" and m.aka_score is not None:
                pdf.drawRightString(x + col_w - 12, mid + 2, f"{m.aka_score}-{m.ao_score}")
            if m.status != "bye":
                # Código del combate: el mismo que usa la planilla de mesa y la app.
                # Debajo de la línea que sale hacia la siguiente ronda: no choca con nombres.
                pdf.setFont("Helvetica", 6)
                pdf.setFillColor(NEZUMI)
                pdf.drawString(x + col_w - 7, mid - 8, m.code)
                pdf.setFillColor(colors.black)
                pdf.setFont("Helvetica", font)
    x = left + rounds * col_w
    final = next((m for m in main if m.round == rounds), None)
    if final:
        pdf.line(x - 10, y_of[final.code], x + col_w - 20, y_of[final.code])
        if with_results and final.winner_registration_id:
            pdf.setFont("Helvetica-Bold", font + 1)
            pdf.drawString(x - 8, y_of[final.code] + 3, pname(final.winner_registration_id)[:40])
    extras = [m for m in b.matches if m.kind != "main"]
    y = bottom - 10
    pdf.setFont("Helvetica", 8)
    for m in extras:
        label = "3.er puesto" if m.kind == "third_place" else f"Repechaje {m.code}"
        aka = pname(m.aka_registration_id) or "(por definir)"
        ao = pname(m.ao_registration_id) or "(por definir)"
        txt = f"{label}: {aka} vs {ao}"
        if with_results and m.winner_registration_id:
            txt += f" → {pname(m.winner_registration_id)}"
        pdf.drawString(left, y, txt[:150])
        y -= 11


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
