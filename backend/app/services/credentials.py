"""Credenciales imprimibles con QR para la mesa de acreditación.

Una credencial por persona (o por equipo): nombre, dojo, categorías y un QR
con su código corto. El QR se dibuja en el servidor con el generador que ya
trae reportlab (``reportlab.graphics.barcode.qr``): sin dependencias nuevas.
"""

from __future__ import annotations

import io
from collections import defaultdict

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Category, Registration
from app.services.checkin import ensure_codes
from app.services.reports import KASUMI, NEZUMI, SUMI, USUZUMI, _enso
from app.services.tournaments import get_tournament

CARD_W, CARD_H = 90 * mm, 62 * mm
COLS, ROWS = 2, 4


def _qr(pdf: canvas.Canvas, value: str, x: float, y: float, size: float) -> None:
    widget = QrCodeWidget(value, barLevel="M")
    x0, y0, x1, y1 = widget.getBounds()
    d = Drawing(size, size, transform=[size / (x1 - x0), 0, 0, size / (y1 - y0), 0, 0])
    d.add(widget)
    renderPDF.draw(d, pdf, x, y)


def credentials(db: Session, tid: int, dojo_id: int | None = None) -> list[dict]:
    """Credenciales del torneo agrupadas por persona (o equipo), ordenadas por dojo y nombre."""
    regs = list(
        db.scalars(
            select(Registration)
            .where(Registration.tournament_id == tid, Registration.status == "active")
            .order_by(Registration.id)
        )
        .unique()
        .all()
    )
    ensure_codes(db, regs)
    db.commit()
    cats = {c.id: c for c in db.scalars(select(Category).where(Category.tournament_id == tid)).all()}
    groups: dict[tuple, dict] = {}
    cat_names: dict[tuple, list[str]] = defaultdict(list)
    for r in regs:
        if dojo_id and r.dojo_id != dojo_id:
            continue
        key = ("p", r.person_id) if r.person_id else ("r", r.id)
        g = groups.setdefault(
            key,
            {
                "name": r.display_name,
                "dojo_name": r.dojo.name if r.dojo else "",
                "code": r.credential_code,
                "person_id": r.person_id,
            },
        )
        c = cats.get(r.category_id)
        if c is not None:
            cat_names[key].append(c.name)
    out = []
    for key, g in groups.items():
        g["categories"] = sorted(cat_names[key])
        out.append(g)
    return sorted(out, key=lambda g: (g["dojo_name"].lower(), g["name"].lower()))


def credentials_pdf(db: Session, tid: int, dojo_id: int | None = None) -> bytes:
    t = get_tournament(db, tid)
    items = credentials(db, tid, dojo_id)
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=A4)
    pdf.setTitle(f"Credenciales — {t.name}")
    W, H = A4
    margin_x = (W - COLS * CARD_W) / 2
    margin_y = (H - ROWS * CARD_H) / 2
    if not items:
        pdf.setFont("Helvetica", 12)
        pdf.drawString(50, H - 80, "No hay inscripciones activas para imprimir credenciales.")
    for i, it in enumerate(items):
        slot = i % (COLS * ROWS)
        if i and slot == 0:
            pdf.showPage()
        col, row = slot % COLS, slot // COLS
        x = margin_x + col * CARD_W
        y = H - margin_y - (row + 1) * CARD_H
        # Línea de corte punteada.
        pdf.setDash(2, 3)
        pdf.setStrokeColor(KASUMI)
        pdf.setLineWidth(0.5)
        pdf.rect(x, y, CARD_W, CARD_H)
        pdf.setDash()
        pad = 5 * mm
        _enso(pdf, x + pad + 4, y + CARD_H - pad - 3, 4)
        pdf.setFillColor(NEZUMI)
        pdf.setFont("Helvetica", 7)
        pdf.drawString(x + pad + 12, y + CARD_H - pad - 5, t.name[:48])
        qr = 26 * mm
        text_w = CARD_W - 2 * pad - qr - 3 * mm
        pdf.setFillColor(SUMI)
        size = 13.0
        while size > 8 and pdf.stringWidth(it["name"], "Helvetica-Bold", size) > text_w:
            size -= 0.5
        pdf.setFont("Helvetica-Bold", size)
        pdf.drawString(x + pad, y + CARD_H - pad - 20, it["name"][:40])
        pdf.setFont("Helvetica", 8.5)
        pdf.setFillColor(USUZUMI)
        pdf.drawString(x + pad, y + CARD_H - pad - 31, it["dojo_name"][:44])
        pdf.setFillColor(SUMI)
        pdf.setFont("Helvetica", 7.5)
        cy = y + CARD_H - pad - 44
        for name in it["categories"][:4]:
            pdf.drawString(x + pad, cy, f"· {name}"[:52])
            cy -= 9.5
        if len(it["categories"]) > 4:
            pdf.drawString(x + pad, cy, f"  y {len(it['categories']) - 4} más")
        if it["code"]:
            qx = x + CARD_W - pad - qr
            qy = y + pad + 7
            _qr(pdf, it["code"], qx, qy, qr)
            pdf.setFont("Courier-Bold", 12)
            pdf.drawCentredString(qx + qr / 2, y + pad, it["code"])
    pdf.showPage()
    pdf.save()
    return buf.getvalue()
