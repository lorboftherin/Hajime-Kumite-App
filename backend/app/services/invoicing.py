"""Comprobantes electrónicos (SUNAT) detrás de la interfaz :class:`Provider`.

``HAJIME_INVOICING_PROVIDER``:

* ``none`` (por defecto): no se emiten comprobantes.
* ``nubefact``: API JSON de Nubefact (OSE/PSE). Se configura con la «ruta» de
  la cuenta (``HAJIME_NUBEFACT_URL``) y su token (``HAJIME_NUBEFACT_TOKEN``).

Al aprobarse un pago se emite:

* **factura** a la organización con RUC (razón social y domicilio fiscal de
  «Organización»);
* **boleta** en los demás casos: a la persona con DNI si lo indicó
  (Competidor Plus), o sin documento («clientes varios»).

Los precios de los planes incluyen IGV (18 %). La numeración es correlativa
por serie y se reserva en la base antes de llamar al proveedor: un reintento
usa el mismo número (no quedan huecos ni duplicados).
"""

from __future__ import annotations

import logging
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import InvalidState
from app.config import get_settings
from app.db.models import Invoice, Organization, Payment, Subscription, User
from app.services import entitlements
from app.services.gateway_http import GatewayError, request_json, sanitize

log = logging.getLogger("hajime.comprobantes")
IGV = Decimal("0.18")


class Provider(Protocol):
    name: str

    def emit(self, invoice: Invoice, payload: dict[str, Any]) -> dict[str, Any]:
        """Envía el comprobante; devuelve la respuesta del proveedor. Lanza GatewayError si falla."""
        ...

    def query(self, invoice: Invoice) -> dict[str, Any]:
        """Consulta un comprobante ya enviado (estado ante SUNAT y enlaces)."""
        ...


class NubefactProvider:
    name = "nubefact"

    def _call(self, body: dict[str, Any]) -> dict[str, Any]:
        s = get_settings()
        if not s.nubefact_url or not s.nubefact_token:
            raise InvalidState("Nubefact no está configurado (HAJIME_NUBEFACT_URL y HAJIME_NUBEFACT_TOKEN)")
        return request_json(
            "POST",
            s.nubefact_url.get_secret_value(),
            headers={"Authorization": f'Token token="{s.nubefact_token.get_secret_value()}"'},
            body=body,
            retries=0,  # sin clave de idempotencia: el reintento lo hace emit_for_payment con el mismo número
        )

    def emit(self, invoice: Invoice, payload: dict[str, Any]) -> dict[str, Any]:
        return self._call(payload)

    def query(self, invoice: Invoice) -> dict[str, Any]:
        return self._call(
            {
                "operacion": "consultar_comprobante",
                "tipo_de_comprobante": 1 if invoice.doc_type == "factura" else 2,
                "serie": invoice.serie,
                "numero": invoice.numero,
            }
        )


PROVIDERS: dict[str, Provider] = {"nubefact": NubefactProvider()}


def provider() -> Provider | None:
    name = get_settings().invoicing_provider
    return None if name == "none" else PROVIDERS.get(name)


def _money(cents: int) -> Decimal:
    return (Decimal(cents) / 100).quantize(Decimal("0.01"))


def _split(total_cents: int) -> tuple[Decimal, Decimal, Decimal]:
    """(gravada, igv, total) a partir del total con IGV."""
    total = _money(total_cents)
    base = (total / (1 + IGV)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return base, total - base, total


def customer_for(db: Session, sub: Subscription) -> tuple[str, str, str, str, str, str]:
    """(tipo de comprobante, tipo de documento, documento, nombre, dirección, correo)."""
    if sub.organization_id is not None:
        org = db.get(Organization, sub.organization_id)
        if org is not None and org.tax_id and len(org.tax_id) == 11:
            return (
                "factura",
                "6",
                org.tax_id,
                org.legal_name or org.name,
                org.tax_address or "",
                org.billing_email or sub.billing_email or "",
            )
        name = (org.legal_name or org.name) if org else "CLIENTES VARIOS"
        return "boleta", "-", "-", name, "", (org.billing_email if org else None) or sub.billing_email or ""
    name = sub.billing_name
    if not name and sub.user_id is not None:
        u = db.get(User, sub.user_id)
        name = (u.display_name or u.username) if u else None
    if sub.billing_doc and len(sub.billing_doc) == 8:
        return "boleta", "1", sub.billing_doc, name or "CLIENTE", "", sub.billing_email or ""
    return "boleta", "-", "-", name or "CLIENTES VARIOS", "", sub.billing_email or ""


def _next_number(db: Session, serie: str) -> int:
    return int(db.scalar(select(func.max(Invoice.numero)).where(Invoice.serie == serie)) or 0) + 1


def build_payload(db: Session, inv: Invoice, pay: Payment, sub: Subscription, address: str, email: str) -> dict:
    plan = entitlements.get_plan(db, sub.plan_code)
    period = "anual" if (pay.period or sub.period) == "year" else "mensual"
    base, igv, total = _split(pay.amount_pen)
    today = datetime.now(ZoneInfo(get_settings().timezone)).strftime("%d-%m-%Y")
    return {
        "operacion": "generar_comprobante",
        "tipo_de_comprobante": 1 if inv.doc_type == "factura" else 2,
        "serie": inv.serie,
        "numero": inv.numero,
        "sunat_transaction": 1,
        "cliente_tipo_de_documento": inv.customer_doc_type,
        "cliente_numero_de_documento": inv.customer_doc,
        "cliente_denominacion": inv.customer_name,
        "cliente_direccion": address,
        "cliente_email": email,
        "fecha_de_emision": today,
        "moneda": 1,  # soles
        "porcentaje_de_igv": 18.00,
        "total_gravada": float(base),
        "total_igv": float(igv),
        "total": float(total),
        "enviar_automaticamente_a_la_sunat": True,
        "enviar_automaticamente_al_cliente": bool(email),
        "codigo_unico": f"hajime-pago-{pay.id}",
        "items": [
            {
                "unidad_de_medida": "ZZ",  # servicio
                "codigo": sub.plan_code,
                "descripcion": f"Suscripción Hajime {plan.name if plan else sub.plan_code} ({period})",
                "cantidad": 1,
                "valor_unitario": float(base),
                "precio_unitario": float(total),
                "subtotal": float(base),
                "tipo_de_igv": 1,  # gravado, operación onerosa
                "igv": float(igv),
                "total": float(total),
                "anticipo_regularizacion": False,
            }
        ],
    }


def _apply_response(inv: Invoice, r: dict[str, Any]) -> None:
    inv.pdf_url = r.get("enlace_del_pdf") or inv.pdf_url
    inv.xml_url = r.get("enlace_del_xml") or inv.xml_url
    inv.cdr_url = r.get("enlace_del_cdr") or inv.cdr_url
    accepted = r.get("aceptada_por_sunat")
    inv.status = (
        "accepted" if accepted else ("rejected" if r.get("sunat_responsecode") not in (None, "", "0") else "pending")
    )
    inv.message = str(r.get("sunat_description") or r.get("sunat_note") or "")[:500]
    inv.raw = {k: v for k, v in r.items() if k not in ("cadena_para_codigo_qr", "codigo_hash", "xml_zip_base64")}


def emit_for_payment(db: Session, pay: Payment) -> Invoice | None:
    """Emite (o reintenta) el comprobante de un pago aprobado. Idempotente por pago."""
    prov = provider()
    if prov is None or pay.status != "approved" or pay.amount_pen <= 0 or pay.subscription_id is None:
        return None
    inv = db.scalar(select(Invoice).where(Invoice.payment_id == pay.id))
    if inv is not None and inv.status in ("accepted", "pending"):
        return inv
    sub = db.get(Subscription, pay.subscription_id)
    if sub is None:
        return None
    doc_type, doc_kind, doc, name, address, email = customer_for(db, sub)
    s = get_settings()
    if inv is None:
        serie = s.nubefact_serie_factura if doc_type == "factura" else s.nubefact_serie_boleta
        for _ in range(3):
            inv = Invoice(
                payment_id=pay.id,
                provider=prov.name,
                doc_type=doc_type,
                serie=serie,
                numero=_next_number(db, serie),
                customer_doc_type=doc_kind,
                customer_doc=doc,
                customer_name=name[:200],
                total_pen=pay.amount_pen,
            )
            try:
                with db.begin_nested():
                    db.add(inv)
                break
            except IntegrityError:  # otro proceso tomó el número: se pide el siguiente
                inv = None
        if inv is None:
            raise RuntimeError("No se pudo reservar el número del comprobante")
        db.commit()  # el número queda reservado aunque el proveedor falle
    try:
        r: dict[str, Any] | None = None
        if inv.status == "error":
            # Quizá sí llegó la primera vez: se consulta antes de reenviar con el mismo número.
            try:
                r = prov.query(inv)
                if not r or r.get("errors"):
                    r = None
            except GatewayError:
                r = None
        if r is None:
            r = prov.emit(inv, build_payload(db, inv, pay, sub, address, email))
        if r.get("errors"):
            raise GatewayError(400, r)
        _apply_response(inv, r)
    except GatewayError as e:
        body = e.body if isinstance(e.body, dict) else {}
        inv.status = "error"
        inv.message = str(body.get("errors") or f"El proveedor respondió {e.status}")[:500]
        inv.raw = {"error": sanitize(body) or {}}
        log.warning("Comprobante %s-%s con error: %s", inv.serie, inv.numero, inv.message)
    return inv


def refresh(db: Session, inv: Invoice) -> Invoice:
    """Consulta el estado ante SUNAT de un comprobante ya enviado."""
    prov = provider()
    if prov is None:
        raise InvalidState("No hay proveedor de comprobantes configurado")
    try:
        _apply_response(inv, prov.query(inv))
    except GatewayError as e:
        inv.message = f"No se pudo consultar ({e.status})"
    return inv
