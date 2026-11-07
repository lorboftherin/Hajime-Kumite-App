"""Avisos Web Push: configuración, suscripción, preferencias y a quién seguir.

Sirven con o sin cuenta: el espectador de la página pública se suscribe sin
iniciar sesión. Para cambiar una suscripción se envía su ``endpoint`` y su
secreto ``auth`` (solo los conoce el navegador que se suscribió). Ver
``app.services.push`` y docs/avisos-push.md.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import DB, CurrentUser, OptionalUser
from app.api.errors import NotFound
from app.api.schemas_push import (
    PushAccountFollowIn,
    PushConfigOut,
    PushPreferencesIn,
    PushPublicFollowIn,
    PushRef,
    PushStateIn,
    PushStateOut,
    PushSubscribeIn,
)
from app.services import push

router = APIRouter(tags=["push"])


@router.get("/push/config", response_model=PushConfigOut)
def push_config():
    """Clave pública VAPID (``applicationServerKey``) o ``enabled: false`` si el servidor no tiene claves."""
    return push.config()


@router.post("/push/subscriptions", response_model=PushStateOut)
def subscribe(data: PushSubscribeIn, db: DB, user: OptionalUser):
    """Suscribe este navegador (o actualiza sus claves). Con sesión, queda ligado a la cuenta."""
    sub = push.subscribe(db, data, user)
    return push.state(db, sub)


@router.post("/push/subscriptions/state", response_model=PushStateOut)
def subscription_state(data: PushStateIn, db: DB):
    """Estado de la suscripción de este navegador: preferencias y a quién sigue
    (``subscribed: false`` si no existe). Con ``tournament``, las claves seguidas allí."""
    try:
        sub = push.get_subscription(db, data.endpoint, data.auth)
    except NotFound:
        return push.state(db, None)
    return push.state(db, sub, data.tournament)


@router.post("/push/subscriptions/unsubscribe", status_code=204)
def unsubscribe(data: PushRef, db: DB):
    """Borra la suscripción de este navegador con todo lo que seguía."""
    push.unsubscribe(db, data.endpoint, data.auth)


@router.put("/push/subscriptions/preferences", response_model=PushStateOut)
def set_preferences(data: PushPreferencesIn, db: DB):
    sub = push.set_preferences(db, data.endpoint, data.auth, data.preferences)
    return push.state(db, sub)


@router.put("/push/follows", response_model=PushStateOut)
def follow_public(data: PushPublicFollowIn, db: DB):
    """Competidores que sigue este navegador en un torneo con página pública (claves
    ``key`` de «¿cuándo pelea?»). Reemplaza la lista; vence al terminar el torneo."""
    sub = push.follow_public(db, data)
    return push.state(db, sub, data.tournament)


@router.put("/me/push/follows", response_model=PushStateOut)
def follow_account(data: PushAccountFollowIn, db: DB, user: CurrentUser):
    """Seguir en este dispositivo el perfil propio, el de un menor a cargo o el de un
    alumno del dojo (sensei), o a todo el dojo. ``follow: false`` deja de seguir."""
    sub = push.follow_account(db, user, data)
    return push.state(db, sub)
