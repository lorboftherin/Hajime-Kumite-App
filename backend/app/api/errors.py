"""Errores con formato uniforme (sección 23).

Todas las respuestas de error tienen la forma::

    {"error": {"code": "...", "message": "...", "details": {...}, "request_id": "..."}}

``request_id`` es el mismo de la cabecera ``X-Request-ID`` y de los logs.

Las advertencias de negocio se devuelven con código ``WARNINGS`` (HTTP 409) y
la lista en ``details.warnings``; el cliente las acepta reenviando la petición
con ``override: {"reason": "..."}``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.domain.errors import DomainError
from app.observability import current_request_id

log = logging.getLogger("hajime.errors")


class AppError(Exception):
    status_code = 400
    code = "BAD_REQUEST"

    def __init__(self, message: str, *, code: str | None = None, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details or {}


class NotFound(AppError):
    status_code = 404
    code = "NOT_FOUND"


class Forbidden(AppError):
    status_code = 403
    code = "FORBIDDEN"


class Unauthorized(AppError):
    status_code = 401
    code = "UNAUTHORIZED"


class TooManyRequests(AppError):
    status_code = 429
    code = "TOO_MANY_ATTEMPTS"


class PlanRequired(AppError):
    """402: la función necesita un plan que la organización (o la persona) no tiene.

    ``details``: ``feature``, ``plan`` (código del plan más económico que la
    incluye), ``plan_name`` y ``organization_id`` si aplica.
    """

    status_code = 402
    code = "PLAN_REQUIRED"


class Conflict(AppError):
    status_code = 409
    code = "CONFLICT"


class VersionConflict(Conflict):
    code = "VERSION_CONFLICT"

    def __init__(self, entity: str, current: int):
        super().__init__(
            f"{entity} fue modificado por otra persona. Recarga y vuelve a intentar.",
            details={"current_version": current},
        )


class InvalidState(AppError):
    status_code = 409
    code = "INVALID_STATE"


class WarningsRequireOverride(AppError):
    status_code = 409
    code = "WARNINGS"

    def __init__(self, warnings: list[dict[str, str]], message: str = "Hay advertencias que requieren confirmación"):
        super().__init__(message, details={"warnings": warnings})


def _body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or {}, "request_id": current_request_id()}}


# Azure SQL serverless en pausa o recién despertando: 40613 (base no disponible),
# 40197 (error del servicio al procesar), HYT00 (tiempo de espera del login).
_DB_WAKING_MARKERS = ("40613", "40197", "HYT00", "is not currently available")
RETRY_AFTER_SECONDS = 10


def _db_waking(exc: BaseException) -> bool:
    text = str(exc)
    return any(m in text for m in _DB_WAKING_MARKERS)


def _unavailable(code: str, message: str) -> JSONResponse:
    return JSONResponse(_body(code, message), status_code=503, headers={"Retry-After": str(RETRY_AFTER_SECONDS)})


def internal_error_response() -> JSONResponse:
    """500 para cualquier error no previsto. El detalle queda en los logs, no en la respuesta."""
    return JSONResponse(
        _body("INTERNAL_ERROR", "Error interno del servidor. Si se repite, avisa indicando el código de la petición."),
        status_code=500,
    )


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(_body(exc.code, exc.message, exc.details), status_code=exc.status_code)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(_body(code, str(exc.detail)), status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(DomainError)
    async def _domain_value(_: Request, exc: DomainError):
        # Solo los errores de validación lanzados a propósito (grado inválido, nota
        # fuera de rango, …) son 400. Un ValueError cualquiera es un error de
        # programación: llega al middleware y se responde 500 con su traza en los logs.
        return JSONResponse(_body("INVALID_VALUE", str(exc)), status_code=400)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        errors = [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg", ""), "type": e.get("type", "")} for e in exc.errors()
        ]
        return JSONResponse(_body("VALIDATION_ERROR", "Datos inválidos", {"errors": errors}), status_code=422)

    @app.exception_handler(PoolTimeoutError)
    async def _pool_exhausted(request: Request, exc: PoolTimeoutError):
        # Todas las conexiones del proceso ocupadas más de db_pool_timeout segundos.
        log.warning("Sin conexiones libres en %s %s: %s", request.method, request.url.path, exc)
        return _unavailable("SERVER_BUSY", "El servidor está ocupado, reintenta en unos segundos")

    @app.exception_handler(IntegrityError)
    async def _integrity(request: Request, exc: IntegrityError):
        # Normalmente dos personas guardando lo mismo a la vez (el servicio ya
        # comprobó los duplicados, pero entre la comprobación y el guardado otro
        # se adelantó). Se registra por si fuera un error de programación.
        log.warning("Restricción de la base en %s %s: %s", request.method, request.url.path, str(exc)[:500])
        return JSONResponse(
            _body("CONFLICT", "Otro usuario guardó un dato que choca con este. Recarga y vuelve a intentar."),
            status_code=409,
        )

    @app.exception_handler(DBAPIError)
    async def _database(request: Request, exc: DBAPIError):
        if _db_waking(exc):
            log.warning("Base de datos en pausa o despertando: %s", str(exc)[:300])
            return _unavailable("DB_WAKING", "La base de datos está despertando, reintenta en unos segundos")
        if isinstance(exc, OperationalError):
            # Conexión caída, base bloqueada, …: suele ser pasajero.
            log.error("Error operativo de la base en %s %s", request.method, request.url.path, exc_info=exc)
            return _unavailable("DB_UNAVAILABLE", "La base de datos no responde, reintenta en unos segundos")
        log.error("Error de base de datos en %s %s", request.method, request.url.path, exc_info=exc)
        return internal_error_response()
