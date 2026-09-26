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

Al reembolsarse un pago con comprobante se emite la **nota de crédito**
(código SUNAT 07; en Nubefact ``tipo_de_comprobante`` 3) por anulación de la
operación, que referencia la boleta o factura.

Los precios de los planes incluyen IGV (18 %). La numeración es correlativa
por tipo y serie y se reserva en la base antes de llamar al proveedor: un
reintento usa el mismo número y primero consulta si ya se emitió (no quedan
huecos ni duplicados).
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
from app.db.models import Invoice, Organization, Payment, Person, Subscription, User
from app.services import entitlements
from app.services.gateway_http import GatewayError, request_json, sanitize

log = logging.getLogger("hajime.comprobantes")
IGV = Decimal("0.18")
CREDIT_NOTE = "nota_credito"
# tipo_de_comprobante de Nubefact: 1 factura, 2 boleta, 3 nota de crédito (SUNAT 01, 03, 07).
NUBEFACT_TYPE = {"factura": 1, "boleta": 2, CREDIT_NOTE: 3}
# tipo_de_nota_de_credito 1 = «Anulación de la operación» (catálogo 09 de SUNAT).
CREDIT_NOTE_REASON = 1


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
            retries=0,  # sin clave de idempotencia: el reintento lo hace _send con el mismo número
        )

    def emit(self, invoice: Invoice, payload: dict[str, Any]) -> dict[str, Any]:
        return self._call(payload)

    def query(self, invoice: Invoice) -> dict[str, Any]:
        return self._call(
            {
                "operacion": "consultar_comprobante",
                "tipo_de_comprobante": NUBEFACT_TYPE[invoice.doc_type],
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
    if not name and sub.person_id is not None:
        p = db.get(Person, sub.person_id)
        name = f"{p.first_names} {p.last_names}".strip() if p else None
    if not name and sub.user_id is not None:
        u = db.get(User, sub.user_id)
        name = (u.display_name or u.username) if u else None
    if sub.billing_doc and len(sub.billing_doc) == 8:
        return "boleta", "1", sub.billing_doc, name or "CLIENTE", "", sub.billing_email or ""
    return "boleta", "-", "-", name or "CLIENTES VARIOS", "", sub.billing_email or ""


def _next_number(db: Session, doc_type: str, serie: str) -> int:
    return (
        int(
            db.scalar(select(func.max(Invoice.numero)).where(Invoice.doc_type == doc_type, Invoice.serie == serie)) or 0
        )
        + 1
    )


def _today() -> str:
    return datetime.now(ZoneInfo(get_settings().timezone)).strftime("%d-%m-%Y")


def build_payload(db: Session, inv: Invoice, pay: Payment, sub: Subscription, address: str, email: str) -> dict:
    plan = entitlements.get_plan(db, sub.plan_code)
    period = "anual" if (pay.period or sub.period) == "year" else "mensual"
    base, igv, total = _split(inv.total_pen)
    body: dict[str, Any] = {
        "operacion": "generar_comprobante",
        "tipo_de_comprobante": NUBEFACT_TYPE[inv.doc_type],
        "serie": inv.serie,
        "numero": inv.numero,
        "sunat_transaction": 1,
        "cliente_tipo_de_documento": inv.customer_doc_type,
        "cliente_numero_de_documento": inv.customer_doc,
        "cliente_denominacion": inv.customer_name,
        "cliente_direccion": address,
        "cliente_email": email,
        "fecha_de_emision": _today(),
        "moneda": 1,  # soles
        "porcentaje_de_igv": 18.00,
        "total_gravada": float(base),
        "total_igv": float(igv),
        "total": float(total),
        "enviar_automaticamente_a_la_sunat": True,
        "enviar_automaticamente_al_cliente": bool(email),
        "codigo_unico": f"hajime-{'nc' if inv.doc_type == CREDIT_NOTE else 'pago'}-{pay.id}",
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
    if inv.doc_type == CREDIT_NOTE:
        orig = db.get(Invoice, inv.refers_to_id) if inv.refers_to_id else None
        assert orig is not None
        body.update(
            {
                "documento_que_se_modifica_tipo": NUBEFACT_TYPE[orig.doc_type],
                "documento_que_se_modifica_serie": orig.serie,
                "documento_que_se_modifica_numero": orig.numero,
                "tipo_de_nota_de_credito": CREDIT_NOTE_REASON,
                "observaciones": "Anulación por reembolso del pago",
            }
        )
    return body


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


def _reserve(db: Session, prov: Provider, pay: Payment, doc_type: str, serie: str, **fields: Any) -> Invoice:
    """Reserva el siguiente número de la serie (reintenta si otro proceso lo tomó) y confirma."""
    for _ in range(3):
        inv = Invoice(
            payment_id=pay.id,
            provider=prov.name,
            doc_type=doc_type,
            serie=serie,
            numero=_next_number(db, doc_type, serie),
            **fields,
        )
        try:
            with db.begin_nested():
                db.add(inv)
        except IntegrityError:  # otro proceso tomó el número: se pide el siguiente
            continue
        db.commit()  # el número queda reservado aunque el proveedor falle
        return inv
    raise RuntimeError("No se pudo reservar el número del comprobante")


def _send(db: Session, prov: Provider, inv: Invoice, pay: Payment, sub: Subscription, address: str, email: str):
    """Envía el comprobante; si antes falló, consulta primero si ya existe con ese número."""
    try:
        r: dict[str, Any] | None = None
        if inv.status == "error":
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


def sale_invoice(db: Session, pay: Payment) -> Invoice | None:
    """La boleta o factura del pago (no la nota de crédito)."""
    return db.scalar(select(Invoice).where(Invoice.payment_id == pay.id, Invoice.doc_type != CREDIT_NOTE))


def credit_note(db: Session, pay: Payment) -> Invoice | None:
    return db.scalar(select(Invoice).where(Invoice.payment_id == pay.id, Invoice.doc_type == CREDIT_NOTE))


def emit_for_payment(db: Session, pay: Payment) -> Invoice | None:
    """Emite (o reintenta) el comprobante de un pago aprobado. Idempotente por pago."""
    prov = provider()
    if prov is None or pay.status not in ("approved", "refunded") or pay.amount_pen <= 0:
        return None
    if pay.subscription_id is None:
        return None
    inv = sale_invoice(db, pay)
    if inv is not None and inv.status in ("accepted", "pending"):
        return inv
    if inv is None and pay.status != "approved":
        return None
    sub = db.get(Subscription, pay.subscription_id)
    if sub is None:
        return None
    doc_type, doc_kind, doc, name, address, email = customer_for(db, sub)
    if inv is None:
        s = get_settings()
        serie = s.nubefact_serie_factura if doc_type == "factura" else s.nubefact_serie_boleta
        inv = _reserve(
            db,
            prov,
            pay,
            doc_type,
            serie,
            customer_doc_type=doc_kind,
            customer_doc=doc,
            customer_name=name[:200],
            total_pen=pay.amount_pen,
        )
    _send(db, prov, inv, pay, sub, address, email)
    return inv


def emit_credit_note(db: Session, pay: Payment) -> Invoice | None:
    """Nota de crédito (anulación) de un pago reembolsado que tenía boleta o factura.

    Sin comprobante de venta emitido (o con él en error) no hay nada que anular.
    Idempotente: si la nota ya existe, solo se reintenta cuando quedó con error.
    """
    prov = provider()
    if prov is None or pay.status != "refunded" or pay.subscription_id is None:
        return None
    orig = sale_invoice(db, pay)
    if orig is None or orig.status not in ("accepted", "pending"):
        return None
    note = credit_note(db, pay)
    if note is not None and note.status in ("accepted", "pending"):
        return note
    sub = db.get(Subscription, pay.subscription_id)
    if sub is None:
        return None
    _, _, _, _, address, email = customer_for(db, sub)
    if note is None:
        s = get_settings()
        serie = s.nubefact_serie_nc_factura if orig.doc_type == "factura" else s.nubefact_serie_nc_boleta
        note = _reserve(
            db,
            prov,
            pay,
            CREDIT_NOTE,
            serie,
            refers_to_id=orig.id,
            customer_doc_type=orig.customer_doc_type,
            customer_doc=orig.customer_doc,
            customer_name=orig.customer_name,
            total_pen=orig.total_pen,
        )
    _send(db, prov, note, pay, sub, address, email)
    return note


def after_refund(db: Session, pay: Payment) -> None:
    """Tras confirmar un reembolso: nota de crédito. Un fallo no deshace el reembolso."""
    try:
        emit_credit_note(db, pay)
        db.commit()
    except Exception:  # noqa: BLE001 - el reembolso ya está confirmado; se reintenta desde «Pagos»
        db.rollback()
        log.exception("No se pudo emitir la nota de crédito del pago %s", pay.id)


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
