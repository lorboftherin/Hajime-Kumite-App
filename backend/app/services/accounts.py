"""Correo de las cuentas: recuperar la contraseña, verificar el correo y registro abierto.

Reglas:

* **No se revela si un correo existe.** ``forgot-password`` y ``signup``
  responden lo mismo exista o no la cuenta; lo distinto va por correo (a quien
  es dueño de esa dirección).
* **Enlaces de un solo uso** con token aleatorio de 256 bits del que solo se
  guarda el hash SHA-256; el de contraseña vence en 1 h y el de verificación
  en 48 h. Pedir otro enlace invalida los anteriores.
* **Restablecer la contraseña cierra todas las sesiones** de la cuenta.
* Límites por IP y por correo en la tabla ``login_attempts`` (la misma del
  bloqueo de inicio de sesión), para que valgan en todos los procesos.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.errors import AppError, Conflict, Forbidden, TooManyRequests, Unauthorized
from app.api.schemas_accounts import check_email, normalize_email
from app.config import get_settings
from app.db.base import utcnow
from app.db.models import EmailVerification, LoginAttempt, PasswordReset, User
from app.security import hash_password, verify_password
from app.services import mail, sessions
from app.services.audit import audit

RESET_TTL = timedelta(hours=1)
VERIFY_TTL = timedelta(hours=48)

# Límites (ventana de 1 h).
WINDOW = timedelta(hours=1)
FORGOT_PER_EMAIL = 3
FORGOT_PER_IP = 20
SIGNUP_PER_IP = 10
VERIFY_RESEND_PER_USER = 5


class InvalidToken(AppError):
    status_code = 400
    code = "INVALID_TOKEN"


# ---------------------------------------------------------------------------
# Límite de peticiones (en la base, compartido entre procesos)
# ---------------------------------------------------------------------------


def _key(kind: str, value: str) -> str:
    # Los correos no se guardan en claro en la tabla de intentos.
    return f"{kind}|{hashlib.sha256(value.encode()).hexdigest()[:40]}"


def allow(db: Session, kind: str, value: str, limit: int, window: timedelta = WINDOW) -> bool:
    """Cuenta un uso de ``kind`` para ``value``; False si ya llegó al límite en la ventana.

    Confirma la transacción (como ``login_guard``): el conteo vale aunque la
    petición falle después.
    """
    key = _key(kind, value)
    now = utcnow()
    for _ in range(3):
        # Dentro de la ventana y por debajo del límite: sumar.
        n = db.execute(
            update(LoginAttempt)
            .where(LoginAttempt.key == key, LoginAttempt.window_start >= now - window, LoginAttempt.failures < limit)
            .values(failures=LoginAttempt.failures + 1)
        ).rowcount
        if n:
            db.commit()
            return True
        # Ventana vencida: empieza de nuevo.
        n = db.execute(
            update(LoginAttempt)
            .where(LoginAttempt.key == key, LoginAttempt.window_start < now - window)
            .values(failures=1, window_start=now, locked_until=None)
        ).rowcount
        if n:
            db.commit()
            return True
        if db.get(LoginAttempt, key) is not None:
            db.rollback()
            return False  # existe, dentro de la ventana y en el límite
        try:
            db.add(LoginAttempt(key=key, failures=1, window_start=now))
            db.commit()
            return True
        except IntegrityError:
            db.rollback()
    return False


def client_ip(request) -> str:
    return (request.client.host if request is not None and request.client else "-")[:45]


# ---------------------------------------------------------------------------
# Tokens de un solo uso
# ---------------------------------------------------------------------------


def _new_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, _hash(token)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def user_by_email(db: Session, email: str) -> User | None:
    email = normalize_email(email)
    return db.scalar(select(User).where(User.email == email)) if email else None


def ensure_email_free(db: Session, email: str, except_user_id: int | None = None) -> None:
    other = user_by_email(db, email)
    if other is not None and other.id != except_user_id:
        raise Conflict("Ese correo ya está en uso por otra cuenta", code="EMAIL_TAKEN")


# ---------------------------------------------------------------------------
# Recuperar la contraseña
# ---------------------------------------------------------------------------

FORGOT_MESSAGE = (
    "Si el correo corresponde a una cuenta, te enviamos un enlace para crear una contraseña nueva. Vence en 1 hora."
)


def request_password_reset(db: Session, email: str, ip: str) -> None:
    """Envía el enlace si existe una cuenta activa con ese correo. Nunca dice si existe."""
    if not allow(db, "fp-ip", ip, FORGOT_PER_IP):
        raise TooManyRequests("Demasiadas solicitudes desde esta conexión. Intenta de nuevo en una hora.")
    email = normalize_email(email)
    if not allow(db, "fp-mail", email, FORGOT_PER_EMAIL):
        return  # misma respuesta: no se envía otro correo a esa dirección por ahora
    user = user_by_email(db, email)
    if user is None or not user.is_active:
        return
    now = utcnow()
    # Solo vale el último enlace pedido.
    db.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
        .values(used_at=now)
    )
    token, token_hash = _new_token()
    db.add(PasswordReset(user_id=user.id, token_hash=token_hash, created_at=now, expires_at=now + RESET_TTL, ip=ip))
    link = f"{get_settings().frontend_url()}/restablecer-clave#{token}"
    mail.enqueue(
        db,
        email,
        mail.render(
            "Crea una contraseña nueva · Hajime",
            "Recupera tu cuenta",
            [
                f"Hola, {user.display_name or user.username}.",
                "Pediste crear una contraseña nueva para tu cuenta de Hajime. El enlace vale una sola vez "
                "y vence en 1 hora.",
                "Si no fuiste tú, ignora este correo: tu contraseña no cambia.",
            ],
            ("Crear contraseña nueva", link),
        ),
        kind="password_reset",
    )
    audit(db, None, "user", user.id, "password_reset_requested", after={"ip": ip})
    db.commit()


def reset_password(db: Session, token: str, new_password: str) -> User:
    """Cambia la contraseña con un enlace válido, lo gasta y cierra todas las sesiones."""
    now = utcnow()
    row = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == _hash(token)))
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise InvalidToken("El enlace no es válido o ya venció. Pide uno nuevo.")
    # Gastar el enlace con un UPDATE condicional: dos envíos a la vez no lo usan dos veces.
    n = db.execute(
        update(PasswordReset)
        .where(PasswordReset.id == row.id, PasswordReset.used_at.is_(None))
        .values(used_at=now)
        .execution_options(synchronize_session=False)
    ).rowcount
    user = db.get(User, row.user_id)
    if not n or user is None or not user.is_active:
        db.rollback()
        raise InvalidToken("El enlace no es válido o ya venció. Pide uno nuevo.")
    user.password_hash = hash_password(new_password)
    user.token_version = (user.token_version or 0) + 1
    user.must_change_password = False
    revoked = sessions.revoke_all(db, user.id)
    audit(db, user, "user", user.id, "password_reset", after={"revoked_sessions": revoked})
    if user.email:
        mail.enqueue(
            db,
            user.email,
            mail.render(
                "Tu contraseña cambió · Hajime",
                "Contraseña actualizada",
                [
                    "La contraseña de tu cuenta de Hajime se cambió con un enlace de recuperación y se cerraron "
                    "todas las sesiones abiertas.",
                    "Si no fuiste tú, recupera tu cuenta de inmediato y avisa a la organización.",
                ],
            ),
            kind="password_changed",
        )
    db.commit()
    return user


# ---------------------------------------------------------------------------
# Verificar el correo
# ---------------------------------------------------------------------------


def send_verification(db: Session, user: User) -> None:
    """Crea un enlace de verificación para el correo actual y lo encola (sin confirmar)."""
    if not user.email:
        return
    now = utcnow()
    db.execute(
        update(EmailVerification)
        .where(EmailVerification.user_id == user.id, EmailVerification.used_at.is_(None))
        .values(used_at=now)
    )
    token, token_hash = _new_token()
    db.add(
        EmailVerification(
            user_id=user.id, email=user.email, token_hash=token_hash, created_at=now, expires_at=now + VERIFY_TTL
        )
    )
    link = f"{get_settings().frontend_url()}/verificar-correo#{token}"
    mail.enqueue(
        db,
        user.email,
        mail.render(
            "Confirma tu correo · Hajime",
            "Confirma tu correo",
            [
                f"Hola, {user.display_name or user.username}.",
                "Confirma que este correo es tuyo para recuperar tu contraseña y reclamar tu perfil deportivo "
                "(o el de tu hijo o hija). El enlace vence en 48 horas.",
                "Si no creaste una cuenta en Hajime, ignora este correo.",
            ],
            ("Confirmar mi correo", link),
        ),
        kind="verify_email",
    )


def resend_verification(db: Session, user: User) -> None:
    if not user.email:
        raise Conflict("Tu cuenta no tiene correo", code="NO_EMAIL")
    if user.email_verified_at is not None:
        raise Conflict("Tu correo ya está verificado", code="ALREADY_VERIFIED")
    if not allow(db, "verify-user", str(user.id), VERIFY_RESEND_PER_USER):
        raise TooManyRequests("Ya enviamos varios enlaces. Revisa tu bandeja (y la de spam) o intenta en una hora.")
    send_verification(db, user)
    db.commit()


def verify_email(db: Session, token: str) -> User:
    now = utcnow()
    row = db.scalar(select(EmailVerification).where(EmailVerification.token_hash == _hash(token)))
    user = db.get(User, row.user_id) if row is not None else None
    if row is None or row.used_at is not None or row.expires_at <= now or user is None or user.email != row.email:
        raise InvalidToken("El enlace no es válido o ya venció. Pide uno nuevo desde tu perfil.")
    row.used_at = now
    user.email_verified_at = now
    audit(db, user, "user", user.id, "verify_email")
    db.commit()
    return user


def set_email(db: Session, actor: User | None, user: User, email: str | None) -> None:
    """Asigna o quita el correo de una cuenta (sin confirmar). Queda sin verificar y se envía el enlace."""
    try:
        new = check_email(email) if email else None
    except ValueError:
        raise Conflict("Correo no válido", code="INVALID_EMAIL") from None
    if new == user.email:
        return
    if new:
        ensure_email_free(db, new, user.id)
    before = {"email": user.email}
    user.email = new
    user.email_verified_at = None
    audit(db, actor, "user", user.id, "set_email", before, {"email": new})
    if new:
        send_verification(db, user)


def update_profile(db: Session, user: User, display_name: str | None, email: str | None, password: str | None):
    if email is not None and normalize_email(email) != (user.email or ""):
        if not password or not verify_password(password, user.password_hash):
            raise Unauthorized("Para cambiar el correo confirma tu contraseña actual")
        set_email(db, user, user, email)
    if display_name is not None and display_name.strip():
        user.display_name = display_name.strip()
    db.commit()
    return user


# ---------------------------------------------------------------------------
# Registro abierto (cuentas de competidor)
# ---------------------------------------------------------------------------

SIGNUP_MESSAGE = "Te enviamos un correo para confirmar la cuenta. Revisa tu bandeja de entrada (y la de spam)."


def signup(db: Session, email: str, password: str, display_name: str, ip: str) -> None:
    """Crea la cuenta y envía la verificación. Si el correo ya existe, avisa por correo (no en la respuesta)."""
    if not get_settings().open_signup:
        raise Forbidden("El registro abierto no está habilitado", code="SIGNUP_CLOSED")
    if not allow(db, "signup-ip", ip, SIGNUP_PER_IP):
        raise TooManyRequests("Demasiados registros desde esta conexión. Intenta de nuevo en una hora.")
    email = check_email(email)
    existing = user_by_email(db, email)
    if existing is not None:
        if allow(db, "fp-mail", email, FORGOT_PER_EMAIL):
            link = f"{get_settings().frontend_url()}/recuperar-clave"
            mail.enqueue(
                db,
                email,
                mail.render(
                    "Ya tienes una cuenta · Hajime",
                    "Ya tienes una cuenta",
                    [
                        "Alguien intentó crear una cuenta de Hajime con este correo, pero ya existe una.",
                        "Si fuiste tú y no recuerdas la contraseña, puedes crear una nueva.",
                    ],
                    ("Recuperar mi cuenta", link),
                ),
                kind="signup_existing",
            )
            db.commit()
        return
    username = email if len(email) <= 80 and db.scalar(select(User.id).where(User.username == email)) is None else ""
    user = User(
        username=username or f"cuenta-{secrets.token_hex(6)}",
        password_hash=hash_password(password),
        display_name=display_name.strip(),
        email=email,
        is_admin=False,
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:  # otro registro con el mismo correo al mismo tiempo
        db.rollback()
        return
    audit(db, user, "user", user.id, "signup", after={"ip": ip})
    send_verification(db, user)
    db.commit()
