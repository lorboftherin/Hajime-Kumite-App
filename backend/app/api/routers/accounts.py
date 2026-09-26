"""Cuentas de competidor: correo, recuperación de contraseña, registro abierto y reclamo de perfiles.

Ver ``app.services.accounts`` y ``app.services.claims``, y docs/cuentas-y-correo.md.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.api import schemas as s
from app.api import schemas_accounts as sa
from app.api.deps import DB, CurrentUser
from app.api.routers.core import user_out
from app.config import get_settings
from app.services import accounts, claims

router = APIRouter()


# --- Recuperar la contraseña y verificar el correo --------------------------------


@router.get("/auth/options", tags=["auth"])
def auth_options():
    """Qué ofrece la pantalla de acceso (sin iniciar sesión)."""
    return {"open_signup": get_settings().open_signup}


@router.post("/auth/forgot-password", response_model=sa.MessageOut, status_code=202, tags=["auth"])
def forgot_password(data: sa.EmailIn, db: DB, request: Request):
    """Envía un enlace para crear una contraseña nueva. Responde igual exista o no el correo."""
    accounts.request_password_reset(db, data.email, accounts.client_ip(request))
    return sa.MessageOut(message=accounts.FORGOT_MESSAGE)


@router.post("/auth/reset-password", status_code=204, tags=["auth"])
def reset_password(data: sa.ResetPasswordIn, db: DB):
    """Crea la contraseña nueva con el enlace (un solo uso, 1 h) y cierra todas las sesiones."""
    accounts.reset_password(db, data.token, data.new_password)


@router.post("/auth/verify-email", response_model=sa.MessageOut, tags=["auth"])
def verify_email(data: sa.TokenIn, db: DB):
    """Confirma el correo con el enlace recibido (no necesita iniciar sesión)."""
    accounts.verify_email(db, data.token)
    return sa.MessageOut(message="Correo confirmado")


@router.post("/auth/verify-email/resend", response_model=sa.MessageOut, status_code=202, tags=["auth"])
def resend_verification(db: DB, user: CurrentUser):
    accounts.resend_verification(db, user)
    return sa.MessageOut(message="Te enviamos un enlace nuevo")


@router.post("/auth/signup", response_model=sa.MessageOut, status_code=202, tags=["auth"])
def signup(data: sa.SignupIn, db: DB, request: Request):
    """Registro abierto (``HAJIME_OPEN_SIGNUP``). Responde igual si el correo ya tenía cuenta."""
    accounts.signup(db, data.email, data.password, data.display_name, accounts.client_ip(request))
    return sa.MessageOut(message=accounts.SIGNUP_MESSAGE)


@router.patch("/auth/me", response_model=s.UserOut, tags=["auth"])
def update_me(data: sa.ProfileUpdate, db: DB, user: CurrentUser):
    """Nombre visible y correo de la propia cuenta (el correo nuevo queda sin verificar)."""
    accounts.update_profile(db, user, data.display_name, data.email, data.current_password)
    return user_out(db, user)


# --- Reclamo de perfiles -------------------------------------------------------


@router.get("/profiles/search", response_model=list[sa.ProfileSearchOut], tags=["claims"])
def search_profiles(q: str, db: DB, _: CurrentUser, dojo_id: int | None = None):
    """Busca perfiles para reclamar: solo nombre abreviado, dojo y torneos."""
    return claims.search(db, q, dojo_id)


@router.post("/profile-claims", response_model=sa.ClaimOut, status_code=201, tags=["claims"])
def create_claim(data: sa.ClaimIn, db: DB, user: CurrentUser):
    c = claims.create_claim(
        db, user, data.public_id, data.relationship, data.evidence, data.document_last4, data.consent
    )
    return next(x for x in claims.my_claims(db, user) if x.id == c.id)


@router.get("/profile-claims/mine", response_model=list[sa.ClaimOut], tags=["claims"])
def my_claims(db: DB, user: CurrentUser):
    return claims.my_claims(db, user)


@router.get("/profile-claims", response_model=list[sa.ClaimReviewOut], tags=["claims"])
def claims_to_review(db: DB, user: CurrentUser, status: str | None = "pending"):
    """Solicitudes que puede revisar el usuario: todas (organizador, Admin) o las de su dojo."""
    return claims.claims_to_review(db, user, status or None)


@router.get("/profile-claims/pending-count", tags=["claims"])
def pending_count(db: DB, user: CurrentUser):
    return {"pending": claims.pending_count(db, user)}


@router.post("/profile-claims/{claim_id}/review", response_model=sa.MessageOut, tags=["claims"])
def review_claim(claim_id: int, data: sa.ClaimReviewIn, db: DB, user: CurrentUser):
    c = claims.review_claim(db, user, claim_id, data.approve, data.reason)
    return sa.MessageOut(message="Solicitud aprobada" if c.status == "approved" else "Solicitud rechazada")


@router.get("/me/profiles", response_model=list[sa.MyProfileOut], tags=["claims"])
def my_profiles(db: DB, user: CurrentUser):
    """El propio perfil y los de los menores a cargo."""
    return claims.my_profiles(db, user)


@router.delete("/me/guardianships/{guardianship_id}", status_code=204, tags=["claims"])
def remove_guardianship(guardianship_id: int, db: DB, user: CurrentUser):
    claims.remove_guardianship(db, user, guardianship_id)
