"""Esquemas de los avisos Web Push (docs/avisos-push.md)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PushConfigOut(BaseModel):
    """Si el servidor tiene claves VAPID y cuál es la pública (``applicationServerKey``)."""

    enabled: bool
    public_key: str | None = None
    soon_ahead: int = Field(description="Se avisa «te toca en ~N combates» cuando faltan N o menos")


class PushKeys(BaseModel):
    p256dh: str = Field(max_length=120)
    auth: str = Field(max_length=60)


class PushPreferences(BaseModel):
    """Qué avisos quiere recibir este dispositivo."""

    turn: bool = Field(True, description="«Te toca en ~N combates» y «¡A tatami!»")
    results: bool = Field(True, description="Resultado de cada combate")
    medals: bool = Field(True, description="Medallas al cerrar la categoría")
    account: bool = Field(True, description="Cuenta: inscripciones revisadas y perfiles aprobados")


class PushSubscribeIn(BaseModel):
    """Lo que entrega ``PushSubscription.toJSON()`` del navegador, más preferencias opcionales."""

    endpoint: str = Field(max_length=800)
    keys: PushKeys
    user_agent: str = Field("", max_length=255)
    preferences: PushPreferences | None = None


class PushRef(BaseModel):
    """Identifica la suscripción de este navegador: el endpoint y su secreto ``auth``
    (solo lo conoce el navegador que se suscribió)."""

    endpoint: str = Field(max_length=800)
    auth: str = Field(max_length=60)


class PushStateIn(PushRef):
    tournament: str | None = Field(None, max_length=80, description="Dirección fija o token: devuelve sus claves")


class PushPreferencesIn(PushRef):
    preferences: PushPreferences


class PushPublicFollowIn(PushRef):
    """Competidores que sigue un espectador en un torneo: reemplaza la lista anterior."""

    tournament: str = Field(max_length=80, description="Dirección fija (slug) o token del enlace público")
    keys: list[str] = Field(default_factory=list, max_length=100)


class PushAccountFollowIn(PushRef):
    """Seguir (o dejar de seguir) un perfil propio, de la familia o de un alumno, o a todo un dojo."""

    person_id: int | None = None
    dojo_id: int | None = None
    follow: bool = True


class PushStateOut(BaseModel):
    subscribed: bool
    account: bool = False
    preferences: PushPreferences = Field(default_factory=PushPreferences)
    keys: list[str] = Field(default_factory=list, description="Claves que sigue en el torneo pedido")
    person_ids: list[int] = Field(default_factory=list)
    dojo_ids: list[int] = Field(default_factory=list)
