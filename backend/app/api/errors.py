"""Errores con formato uniforme (sección 23).

Todas las respuestas de error tienen la forma::

    {"error": {"code": "...", "message": "...", "details": {...}}}

Las advertencias de negocio se devuelven con código ``WARNINGS`` (HTTP 409) y
la lista en ``details.warnings``; el cliente las acepta reenviando la petición
con ``override: {"reason": "..."}``.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


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
    return {"error": {"code": code, "message": message, "details": details or {}}}


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError):
        return JSONResponse(_body(exc.code, exc.message, exc.details), status_code=exc.status_code)

    @app.exception_handler(ValueError)
    async def _domain_value(_: Request, exc: ValueError):
        # El dominio valida con ValueError (grado inválido, nota fuera de rango, …).
        return JSONResponse(_body("INVALID_VALUE", str(exc)), status_code=400)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        errors = [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg", ""), "type": e.get("type", "")} for e in exc.errors()
        ]
        return JSONResponse(_body("VALIDATION_ERROR", "Datos inválidos", {"errors": errors}), status_code=422)
