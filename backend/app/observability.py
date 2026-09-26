"""Registro (logs), identificador de petición y cabeceras de seguridad.

- Cada petición lleva un identificador: el que mande el cliente o el proxy en
  `X-Request-ID`, o uno nuevo. Se devuelve en la respuesta, va en cada línea
  de log y en el cuerpo de los errores, así un «me salió un error» del usuario
  se encuentra en los logs de Azure.
- Los logs salen a stdout en JSON (una línea por evento), que es lo que
  Container Apps recoge y Log Analytics sabe consultar por campos.
- Si hay `APPLICATIONINSIGHTS_CONNECTION_STRING`, se activa Azure Monitor
  (OpenTelemetry). Es opcional: sin el paquete, se avisa y se sigue.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import uuid
from contextvars import ContextVar
from datetime import UTC, datetime

log = logging.getLogger("hajime")
access_log = logging.getLogger("hajime.access")

_request_id: ContextVar[str | None] = ContextVar("hajime_request_id", default=None)
# Solo se acepta un identificador razonable del cliente: evita inyectar basura en los logs.
_VALID_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def current_request_id() -> str | None:
    return _request_id.get()


# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------

_EXTRA_FIELDS = ("method", "path", "status", "duration_ms", "client")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = getattr(record, "request_id", None) or _request_id.get()
        if rid:
            data["request_id"] = rid
        for k in _EXTRA_FIELDS:
            if hasattr(record, k):
                data[k] = getattr(record, k)
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, ensure_ascii=False, default=str)


class _TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        rid = getattr(record, "request_id", None)
        return super().format(record) + (f" [{rid}]" if rid else "")


_factory_installed = False


def _install_record_factory() -> None:
    """Sella el identificador de petición en cada registro al crearlo.

    Así lo ve cualquier manejador (también el de Azure Monitor o el de las
    pruebas), aunque formatee el registro después de terminada la petición.
    """
    global _factory_installed
    if _factory_installed:
        return
    _factory_installed = True
    previous = logging.getLogRecordFactory()

    def factory(*args, **kwargs):
        record = previous(*args, **kwargs)
        if not hasattr(record, "request_id"):
            record.request_id = _request_id.get()
        return record

    logging.setLogRecordFactory(factory)


def configure_logging(level: str = "INFO", fmt: str = "json") -> None:
    """Un solo manejador en stdout para la app y uvicorn. Se puede llamar varias veces."""
    _install_record_factory()
    root = logging.getLogger()
    handler = next((h for h in root.handlers if getattr(h, "_hajime", False)), None)
    if handler is None:
        handler = logging.StreamHandler(sys.stdout)
        handler._hajime = True  # type: ignore[attr-defined]
        root.addHandler(handler)
    handler.setFormatter(
        JsonFormatter() if fmt == "json" else _TextFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root.setLevel(level.upper())
    # uvicorn trae sus propios manejadores en texto: se pasan al de la app. Su
    # registro de accesos se apaga porque el middleware ya escribe uno por
    # petición, con el identificador y la duración.
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
    access = logging.getLogger("uvicorn.access")
    access.handlers.clear()
    access.propagate = True
    access.setLevel(logging.WARNING)


_monitor_done = False


def configure_azure_monitor() -> None:
    """Application Insights si hay cadena de conexión (una vez por proceso)."""
    global _monitor_done
    if _monitor_done or not os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        return
    _monitor_done = True
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor as _configure
    except ImportError:
        log.warning(
            "APPLICATIONINSIGHTS_CONNECTION_STRING está definida pero falta el paquete "
            "azure-monitor-opentelemetry (pip install 'hajime-api[azure]'); se sigue sin telemetría"
        )
        return
    try:
        _configure()
    except Exception:  # noqa: BLE001 - la telemetría nunca debe impedir arrancar
        log.exception("No se pudo activar Azure Monitor; se sigue sin telemetría")


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------


class RequestContextMiddleware:
    """Identificador de petición, log de acceso, cabeceras de seguridad y red final.

    ASGI puro (no BaseHTTPMiddleware) para no romper las descargas en streaming.
    Cualquier excepción que nadie manejó termina aquí: se registra con su traza
    y se responde 500 en JSON con el mismo formato que el resto de errores.
    """

    def __init__(self, app, *, hsts: bool = False, frame_allowed_prefixes: tuple[str, ...] = ()):
        self.app = app
        self.hsts = hsts
        self.frame_allowed_prefixes = frame_allowed_prefixes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        rid = None
        for k, v in scope.get("headers", ()):
            if k == b"x-request-id":
                rid = v.decode("latin-1")
                break
        if not rid or not _VALID_ID.match(rid):
            rid = uuid.uuid4().hex
        token = _request_id.set(rid)
        path = scope.get("path", "")
        started = time.perf_counter()
        status = 500
        response_started = False

        async def send_wrapper(message):
            nonlocal status, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status = message["status"]
                headers = list(message.get("headers", ()))
                headers.append((b"x-request-id", rid.encode()))
                headers.extend(self._security_headers(path, headers))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("Error no controlado en %s %s", scope.get("method"), path)
            if response_started:
                raise  # ya se envió parte de la respuesta: no hay forma limpia de avisar
            from app.api.errors import internal_error_response

            await internal_error_response()(scope, receive, send_wrapper)
        finally:
            ms = round((time.perf_counter() - started) * 1000, 1)
            client = scope.get("client")
            access_log.log(
                logging.DEBUG if path.startswith("/health") else logging.INFO,
                "%s %s %s %sms",
                scope.get("method"),
                path,
                status,
                ms,
                extra={
                    "method": scope.get("method"),
                    "path": path,
                    "status": status,
                    "duration_ms": ms,
                    "client": client[0] if client else None,
                },
            )
            _request_id.reset(token)

    def _security_headers(self, path: str, existing: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
        names = {k.lower() for k, _ in existing}
        out = [
            (b"x-content-type-options", b"nosniff"),
            (b"referrer-policy", b"strict-origin-when-cross-origin"),
        ]
        # El overlay de transmisión se incrusta en OBS u otras páginas: es lo único
        # que puede ir dentro de un marco. El resto no, contra el clickjacking.
        if not path.startswith(self.frame_allowed_prefixes):
            out.append((b"x-frame-options", b"DENY"))
        if self.hsts:
            out.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
        return [(k, v) for k, v in out if k not in names]
