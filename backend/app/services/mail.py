"""Correo transaccional: bandeja de salida en la base y proveedores intercambiables.

Nunca se envía un correo dentro de la petición HTTP: la petición solo agrega
una fila a ``outbox_emails`` en su propia transacción (:func:`enqueue`). Si la
petición falla, el correo no sale; si el proveedor está caído, la petición no
se entera. Un despachador lo envía después:

* un hilo de fondo en cada proceso de la API (:class:`MailDispatcher`, lo
  arranca el *lifespan* si ``HAJIME_MAIL_DISPATCHER`` está activo), y/o
* ``python -m app.mail_worker`` (p. ej. un Container Apps Job programado).

Varios despachadores pueden correr a la vez (varios procesos y copias): cada
correo se **reserva** con un UPDATE condicional (``status='sending'`` y
``locked_until`` = ahora + *lease*). Solo el UPDATE que afecta la fila gana; si
el proceso muere a mitad del envío, la reserva vence y otro lo retoma.
Los fallos se reintentan con espera creciente hasta ``HAJIME_MAIL_MAX_ATTEMPTS``.

Proveedores (``HAJIME_MAIL_PROVIDER``):

* ``console``: registra el correo en el log y lo guarda en memoria
  (:data:`CONSOLE_OUTBOX`); por defecto en desarrollo y en las pruebas.
* ``smtp``: ``smtplib`` de la biblioteca estándar con STARTTLS.
* ``acs``: Azure Communication Services Email por REST, firmado con HMAC-SHA256
  (sin SDK). Ver docs/cuentas-y-correo.md.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html as html_lib
import json
import logging
import smtplib
import ssl
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import timedelta
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from typing import Protocol
from urllib.parse import urlsplit

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, get_settings
from app.db.base import utcnow
from app.db.models import OutboxEmail

log = logging.getLogger("hajime.mail")

# ---------------------------------------------------------------------------
# Proveedores
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MailMessage:
    to: str
    subject: str
    html: str
    text: str


class MailError(Exception):
    """Fallo al enviar. ``permanent``: no tiene sentido reintentar (dirección o configuración inválida)."""

    def __init__(self, message: str, permanent: bool = False):
        super().__init__(message)
        self.permanent = permanent


class MailProvider(Protocol):
    name: str

    def send(self, msg: MailMessage) -> None: ...


# Correos «enviados» por el proveedor de consola (las pruebas los leen de aquí).
CONSOLE_OUTBOX: list[MailMessage] = []


class ConsoleProvider:
    name = "console"

    def send(self, msg: MailMessage) -> None:
        CONSOLE_OUTBOX.append(msg)
        # Solo en desarrollo: el cuerpo puede llevar enlaces de un solo uso.
        log.info("Correo (consola) para %s: %s\n%s", msg.to, msg.subject, msg.text)


class SmtpProvider:
    name = "smtp"

    def __init__(self, s: Settings):
        if not s.smtp_host:
            raise MailError("Falta HAJIME_SMTP_HOST", permanent=True)
        self.s = s

    def send(self, msg: MailMessage) -> None:
        s = self.s
        sender = s.smtp_from or s.mail_from
        em = EmailMessage()
        em["From"] = sender
        em["To"] = msg.to
        em["Subject"] = msg.subject
        em["Date"] = formatdate(localtime=False)
        em["Message-ID"] = make_msgid(domain=(parseaddr(sender)[1].split("@")[-1] or None))
        em.set_content(msg.text)
        em.add_alternative(msg.html, subtype="html")
        try:
            with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=s.smtp_timeout) as smtp:
                smtp.ehlo()
                if s.smtp_starttls:
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                if s.smtp_user:
                    smtp.login(s.smtp_user, s.smtp_password or "")
                smtp.send_message(em)
        except smtplib.SMTPRecipientsRefused as e:
            raise MailError(f"Destinatario rechazado: {e}", permanent=True) from e
        except smtplib.SMTPAuthenticationError as e:
            raise MailError(f"SMTP rechazó las credenciales ({e.smtp_code})") from e
        except (smtplib.SMTPException, OSError) as e:
            raise MailError(f"SMTP: {type(e).__name__}: {e}") from e


ACS_API_VERSION = "2023-03-31"


def acs_signed_headers(method: str, url: str, body: bytes, access_key: str, date: str | None = None) -> dict[str, str]:
    """Cabeceras de autenticación HMAC-SHA256 de Azure Communication Services.

    Cadena firmada: ``MÉTODO\\nruta?consulta\\nfecha;host;hash-del-cuerpo``.
    """
    parts = urlsplit(url)
    path_and_query = parts.path + (f"?{parts.query}" if parts.query else "")
    date = date or formatdate(usegmt=True)
    content_hash = base64.b64encode(hashlib.sha256(body).digest()).decode()
    to_sign = f"{method.upper()}\n{path_and_query}\n{date};{parts.netloc};{content_hash}"
    signature = base64.b64encode(
        hmac.new(base64.b64decode(access_key), to_sign.encode(), hashlib.sha256).digest()
    ).decode()
    return {
        "x-ms-date": date,
        "x-ms-content-sha256": content_hash,
        "Authorization": (f"HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature={signature}"),
    }


class AcsProvider:
    name = "acs"

    def __init__(self, s: Settings):
        if not (s.acs_endpoint and s.acs_access_key):
            raise MailError("Faltan HAJIME_ACS_ENDPOINT y HAJIME_ACS_ACCESS_KEY", permanent=True)
        self.s = s

    def send(self, msg: MailMessage) -> None:
        s = self.s
        sender = s.acs_sender or parseaddr(s.mail_from)[1]
        url = f"{s.acs_endpoint.rstrip('/')}/emails:send?api-version={ACS_API_VERSION}"
        body = json.dumps(
            {
                "senderAddress": sender,
                "recipients": {"to": [{"address": msg.to}]},
                "content": {"subject": msg.subject, "plainText": msg.text, "html": msg.html},
            }
        ).encode()
        headers = {"Content-Type": "application/json", **acs_signed_headers("POST", url, body, s.acs_access_key)}
        req = urllib.request.Request(url, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=s.smtp_timeout) as resp:  # noqa: S310 - URL de configuración
                if resp.status not in (200, 202):
                    raise MailError(f"ACS respondió {resp.status}")
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode(errors="replace")
            # 429 y 5xx: reintentar; el resto (400, 401, 403…) no se arregla solo.
            raise MailError(f"ACS {e.code}: {detail}", permanent=e.code < 500 and e.code != 429) from e
        except (urllib.error.URLError, OSError) as e:
            raise MailError(f"ACS sin respuesta: {e}") from e


_PROVIDERS = {"console": ConsoleProvider, "smtp": SmtpProvider, "acs": AcsProvider}


def get_provider(s: Settings | None = None) -> MailProvider:
    s = s or get_settings()
    name = (s.mail_provider or "console").lower()
    if name not in _PROVIDERS:
        raise MailError(f"HAJIME_MAIL_PROVIDER desconocido: {name}", permanent=True)
    if name == "console":
        return ConsoleProvider()
    return _PROVIDERS[name](s)


# ---------------------------------------------------------------------------
# Plantillas (HTML simple con la marca + texto plano siempre)
# ---------------------------------------------------------------------------

# Colores de docs/marca/README.md y frontend/src/styles.scss (tema claro).
_WASHI = "#F5F0E6"
_KINU = "#FBF8F2"
_SUMI = "#1E1C1A"
_SUMI_2 = "#4A463F"
_NEZUMI = "#6B655A"
_SHU = "#B8322A"
_KASUMI = "#E3DBCB"


@dataclass(frozen=True)
class Rendered:
    subject: str
    html: str
    text: str


def render(
    subject: str,
    title: str,
    paragraphs: list[str],
    action: tuple[str, str] | None = None,
    footer: str = "",
) -> Rendered:
    """Arma un correo con la marca. ``paragraphs`` es texto (se escapa); ``action`` = (texto, URL)."""
    base = get_settings().frontend_url()
    logo = f"{base}/icons/hajime-logo-horizontal.png"
    esc = html_lib.escape
    body = "".join(
        f'<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:{_SUMI_2}">{esc(p)}</p>' for p in paragraphs
    )
    button = ""
    if action:
        label, url = action
        button = (
            f'<p style="margin:24px 0"><a href="{esc(url, quote=True)}" '
            f'style="display:inline-block;background:{_SHU};color:#FFFFFF;text-decoration:none;'
            f'font-weight:700;padding:12px 22px;border-radius:6px">{esc(label)}</a></p>'
            f'<p style="margin:0 0 16px;font-size:13px;color:{_NEZUMI}">Si el botón no funciona, copia este '
            f'enlace en el navegador:<br><span style="word-break:break-all">{esc(url)}</span></p>'
        )
    footer_text = footer or "Recibes este correo por una acción en tu cuenta de Hajime."
    html = f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{esc(subject)}</title></head>
<body style="margin:0;padding:0;background:{_WASHI};font-family:Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_WASHI}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
 style="max-width:560px;background:{_KINU};border:1px solid {_KASUMI};border-radius:10px">
<tr><td style="padding:24px 28px 8px">
<img src="{esc(logo, quote=True)}" alt="Hajime" width="160" style="display:block;width:160px;height:auto">
</td></tr>
<tr><td style="padding:8px 28px 24px">
<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-weight:600;font-size:24px;color:{_SUMI}">{esc(title)}</h1>
{body}{button}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid {_KASUMI};font-size:12px;color:{_NEZUMI}">
{esc(footer_text)}<br>Hajime · Torneos de karate
</td></tr>
</table></td></tr></table></body></html>"""
    lines = [title, "", *[p + "\n" for p in paragraphs]]
    if action:
        lines += [f"{action[0]}: {action[1]}", ""]
    lines += ["--", footer_text, "Hajime · Torneos de karate"]
    return Rendered(subject, html, "\n".join(lines))


# ---------------------------------------------------------------------------
# Bandeja de salida
# ---------------------------------------------------------------------------


def enqueue(db: Session, to: str, rendered: Rendered, kind: str = "") -> OutboxEmail:
    """Agrega el correo a la bandeja de salida (sin confirmar: va en la transacción de quien llama)."""
    row = OutboxEmail(
        to_address=to,
        subject=rendered.subject[:250],
        html=rendered.html,
        text=rendered.text,
        kind=kind[:40],
        status="pending",
        attempts=0,
        next_attempt_at=utcnow(),
    )
    db.add(row)
    return row


def backoff(attempts: int) -> timedelta:
    """Espera antes del siguiente intento: 30 s, 1 min, 2 min… hasta 1 h."""
    return timedelta(seconds=min(3600, 30 * 2 ** max(0, attempts - 1)))


def _ready(now):
    return or_(
        and_(OutboxEmail.status == "pending", OutboxEmail.next_attempt_at <= now),
        and_(OutboxEmail.status == "sending", OutboxEmail.locked_until < now),
    )


def claim(db: Session, email_id: int, lease_seconds: int) -> bool:
    """Reserva un correo para enviarlo (UPDATE condicional). True si lo ganó este proceso."""
    now = utcnow()
    res = db.execute(
        update(OutboxEmail)
        .where(OutboxEmail.id == email_id, _ready(now))
        .values(
            status="sending",
            locked_until=now + timedelta(seconds=lease_seconds),
            attempts=OutboxEmail.attempts + 1,
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return (res.rowcount or 0) == 1


def dispatch_once(session_factory: sessionmaker[Session], limit: int = 20, s: Settings | None = None) -> int:
    """Envía hasta ``limit`` correos listos. Devuelve cuántos se enviaron."""
    s = s or get_settings()
    sent = 0
    with session_factory() as db:
        ids = db.scalars(select(OutboxEmail.id).where(_ready(utcnow())).order_by(OutboxEmail.id).limit(limit)).all()
        if not ids:
            return 0
        try:
            provider = get_provider(s)
        except MailError as e:
            log.error("Correo sin proveedor válido: %s", e)
            return 0
        for email_id in ids:
            if not claim(db, email_id, s.mail_lease_seconds):
                continue  # otro proceso lo tomó
            row = db.get(OutboxEmail, email_id)
            if row is None:  # pragma: no cover - borrado entre medio
                continue
            db.refresh(row)
            try:
                provider.send(MailMessage(row.to_address, row.subject, row.html, row.text))
            except Exception as e:  # noqa: BLE001 - cualquier fallo se registra y se reintenta
                permanent = isinstance(e, MailError) and e.permanent
                row.last_error = str(e)[:1000]
                row.locked_until = None
                if permanent or row.attempts >= s.mail_max_attempts:
                    row.status = "failed"
                    log.error("Correo %s descartado tras %s intentos: %s", row.id, row.attempts, row.last_error)
                else:
                    row.status = "pending"
                    row.next_attempt_at = utcnow() + backoff(row.attempts)
                    log.warning("Correo %s falló (intento %s): %s", row.id, row.attempts, row.last_error)
                db.commit()
                continue
            row.status = "sent"
            row.sent_at = utcnow()
            row.locked_until = None
            row.last_error = None
            db.commit()
            sent += 1
    return sent


def drain(session_factory: sessionmaker[Session], s: Settings | None = None, max_rounds: int = 50) -> int:
    """Envía todo lo que esté listo ahora (lo usa ``python -m app.mail_worker``)."""
    total = 0
    for _ in range(max_rounds):
        n = dispatch_once(session_factory, s=s)
        total += n
        if n == 0:
            break
    return total


class MailDispatcher:
    """Hilo de fondo que revisa la bandeja de salida cada ``mail_poll_seconds``."""

    def __init__(self, session_factory: sessionmaker[Session], s: Settings | None = None):
        self.session_factory = session_factory
        self.s = s or get_settings()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="hajime-mail", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)

    def _run(self) -> None:
        from app.services import billing_mail

        while not self._stop.is_set():
            try:
                # Avisos de vencimiento de planes (a lo sumo una vez por hora; sin repetir).
                billing_mail.run_if_due(self.session_factory)
            except Exception:  # noqa: BLE001 - no debe detener el envío de correos
                log.exception("Los avisos de vencimiento de planes fallaron")
            try:
                dispatch_once(self.session_factory, s=self.s)
            except Exception:  # noqa: BLE001 - p. ej. la base pausada: se reintenta en la próxima vuelta
                log.exception("El despachador de correo falló; reintenta en %s s", self.s.mail_poll_seconds)
            self._stop.wait(self.s.mail_poll_seconds)
