"""Avisos Web Push: suscripciones, a quién siguen, bandeja de salida y despachador.

Ver docs/avisos-push.md. Piezas:

* **Suscripción** (``push_subscriptions``): una por navegador. Se crea con o
  sin cuenta; para cambiarla sin sesión se exige el secreto ``auth`` que solo
  conoce ese navegador. El endpoint debe ser https y de un servicio de push
  conocido (``HAJIME_PUSH_ALLOWED_HOSTS``): el servidor le hace POST y no debe
  poder usarse para llegar a otra URL.
* **A quién sigue** (``push_follows``): claves públicas de un torneo (espectador
  sin cuenta, vencen al terminar el torneo), perfiles (cuenta: el propio, la
  familia, alumnos del sensei) o un dojo entero.
* **Qué se avisa**: el turno, resultados y medallas los calcula
  ``app.services.push_eval`` recorriendo el torneo tras cada cambio; los de
  cuenta (inscripción revisada, perfil aprobado) se encolan aquí
  (:func:`notify_users`) en la transacción de quien llama.
* **Envío** (``notification_outbox``): como el correo, fuera de la petición.
  Un lote se reserva con un UPDATE condicional (``claimed_by`` + *lease*), los
  POST salen en paralelo y el resultado se guarda en una transacción. 404/410
  borran la suscripción; 429/5xx y la red se reintentan con espera creciente;
  pasado ``expires_at`` (turno: 10 min) ya no se envía.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading
import time
import uuid
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.api.errors import Conflict, Forbidden, NotFound
from app.api.schemas_push import (
    PushAccountFollowIn,
    PushConfigOut,
    PushPreferences,
    PushPublicFollowIn,
    PushStateOut,
    PushSubscribeIn,
)
from app.config import Settings, get_settings
from app.db.base import utcnow
from app.db.models import (
    Guardianship,
    NotificationOutbox,
    PushFollow,
    PushSubscription,
    Registration,
    Tournament,
    User,
)
from app.services import webpush

log = logging.getLogger("hajime.push")

# Tipo de aviso → preferencia que lo controla.
PREFERENCE_OF = {
    "soon": "turn",
    "next": "turn",
    "result": "results",
    "medal": "medals",
    "registration": "account",
    "claim": "account",
}
MAX_KEYS_PER_TOURNAMENT = 100
MAX_ACCOUNT_FOLLOWS = 200
ICON = "/icons/icon-192x192.png"
BADGE = "/icons/icon-96x96.png"


def enabled(s: Settings | None = None) -> bool:
    s = s or get_settings()
    return bool(s.vapid_public_key and s.vapid_private_key)


def config() -> PushConfigOut:
    s = get_settings()
    on = enabled(s)
    return PushConfigOut(
        enabled=on, public_key=s.vapid_public_key.strip() if on else None, soon_ahead=s.push_soon_ahead
    )


def preferences(sub: PushSubscription) -> dict[str, bool]:
    return PushPreferences.model_validate(sub.preferences or {}).model_dump()


def wants(prefs: dict[str, Any] | None, kind: str) -> bool:
    """¿La suscripción quiere este tipo de aviso? (sin preferencias guardadas: todos)."""
    key = PREFERENCE_OF.get(kind, kind)
    return bool((prefs or {}).get(key, True))


# ---------------------------------------------------------------------------
# Suscripciones
# ---------------------------------------------------------------------------


def allowed_endpoint(endpoint: str, s: Settings | None = None) -> bool:
    s = s or get_settings()
    if not endpoint.isascii() or len(endpoint) > 800:
        return False
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or parts.username or parts.password:
        return False
    return any(host == h or host.endswith("." + h) for h in (x.lower().strip(".") for x in s.push_allowed_hosts))


def _by_endpoint(db: Session, endpoint: str) -> PushSubscription | None:
    return db.scalar(select(PushSubscription).where(PushSubscription.endpoint == endpoint))


def get_subscription(db: Session, endpoint: str, auth: str) -> PushSubscription:
    """La suscripción de este navegador (endpoint y secreto ``auth`` coinciden) o 404."""
    sub = _by_endpoint(db, endpoint)
    if sub is None or not hmac.compare_digest(sub.auth.encode(), (auth or "").encode()):
        raise NotFound("Este dispositivo no está suscrito a los avisos")
    return sub


def subscribe(db: Session, data: PushSubscribeIn, user: User | None) -> PushSubscription:
    """Crea o actualiza la suscripción del navegador. Con sesión, queda ligada a la cuenta."""
    if not enabled():
        raise Conflict("Los avisos no están activos en este servidor", code="PUSH_DISABLED")
    if not allowed_endpoint(data.endpoint):
        raise Conflict("El servicio de avisos de este navegador no está admitido", code="PUSH_ENDPOINT")
    if not webpush.valid_client_keys(data.keys.p256dh, data.keys.auth):
        raise Conflict("Las claves de la suscripción no son válidas", code="PUSH_KEYS")
    sub = _by_endpoint(db, data.endpoint)
    if sub is None:
        sub = PushSubscription(endpoint=data.endpoint, created_at=utcnow(), failures=0)
        db.add(sub)
    elif sub.auth != data.keys.auth and sub.user_id is not None and (user is None or user.id != sub.user_id):
        # Mismo endpoint con claves nuevas: el navegador renovó la suscripción. Lo
        # que seguía la cuenta anterior no pasa a quien no inició sesión.
        _drop_account_follows(db, sub)
        sub.user_id = None
    sub.p256dh = data.keys.p256dh
    sub.auth = data.keys.auth
    sub.user_agent = (data.user_agent or "")[:255]
    sub.failures = 0
    if user is not None:
        if sub.user_id is not None and sub.user_id != user.id:
            _drop_account_follows(db, sub)  # otra cuenta en el mismo navegador: empieza de cero
        sub.user_id = user.id
    if data.preferences is not None:
        sub.preferences = data.preferences.model_dump()
    db.commit()
    return sub


def _drop_account_follows(db: Session, sub: PushSubscription) -> None:
    if sub.id is not None:
        db.execute(delete(PushFollow).where(PushFollow.subscription_id == sub.id, PushFollow.person_key.is_(None)))


def delete_subscriptions(db: Session, ids: Iterable[int]) -> None:
    """Borra suscripciones con lo que siguen y sus avisos (sin confirmar)."""
    ids = list(ids)
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        db.execute(delete(PushFollow).where(PushFollow.subscription_id.in_(chunk)))
        db.execute(delete(NotificationOutbox).where(NotificationOutbox.subscription_id.in_(chunk)))
        db.execute(delete(PushSubscription).where(PushSubscription.id.in_(chunk)))


def unsubscribe(db: Session, endpoint: str, auth: str) -> None:
    sub = get_subscription(db, endpoint, auth)
    delete_subscriptions(db, [sub.id])
    db.commit()


def set_preferences(db: Session, endpoint: str, auth: str, prefs: PushPreferences) -> PushSubscription:
    sub = get_subscription(db, endpoint, auth)
    sub.preferences = prefs.model_dump()
    db.commit()
    return sub


def resolve_tournament(db: Session, ref: str) -> Tournament:
    """Torneo con el público activo por su dirección fija o su token."""
    ref = (ref or "").strip()
    t = None
    if ref:
        t = db.scalar(
            select(Tournament).where(Tournament.public_slug == ref.lower(), Tournament.public_token.is_not(None))
        ) or db.scalar(select(Tournament).where(Tournament.public_token == ref))
    if t is None:
        raise NotFound("Este torneo no existe o no tiene la página pública activa")
    return t


def state(db: Session, sub: PushSubscription | None, tournament: str | None = None) -> PushStateOut:
    if sub is None:
        return PushStateOut(subscribed=False)
    follows = db.scalars(select(PushFollow).where(PushFollow.subscription_id == sub.id)).all()
    keys: list[str] = []
    if tournament:
        try:
            tid = resolve_tournament(db, tournament).id
        except NotFound:
            tid = None
        keys = sorted({f.person_key for f in follows if f.tournament_id == tid and f.person_key})
    return PushStateOut(
        subscribed=True,
        account=sub.user_id is not None,
        preferences=PushPreferences.model_validate(sub.preferences or {}),
        keys=keys,
        person_ids=sorted({f.person_id for f in follows if f.person_id}),
        dojo_ids=sorted({f.dojo_id for f in follows if f.dojo_id}),
    )


def follow_expiry(t: Tournament) -> datetime:
    """Los favoritos de un espectador vencen al día siguiente del último día del torneo."""
    last = t.end_date or t.start_date
    return datetime(last.year, last.month, last.day) + timedelta(days=1, hours=12)


def valid_keys(db: Session, t: Tournament) -> set[str]:
    """Claves públicas (``key`` de «¿cuándo pelea?») de los competidores del torneo."""
    from app.services.public import public_key

    rows = db.execute(
        select(Registration.id, Registration.person_id, Registration.team_id).where(
            Registration.tournament_id == t.id, Registration.status == "active"
        )
    ).all()
    return {public_key(t.id, "e", team) if team else public_key(t.id, "p", pid or -rid) for rid, pid, team in rows}


def follow_public(db: Session, data: PushPublicFollowIn) -> PushSubscription:
    """Reemplaza los competidores que sigue este navegador en un torneo (página pública)."""
    sub = get_subscription(db, data.endpoint, data.auth)
    t = resolve_tournament(db, data.tournament)
    wanted = {k.strip().lower() for k in data.keys if k and len(k) <= 24}
    if len(wanted) > MAX_KEYS_PER_TOURNAMENT:
        raise Conflict(f"Máximo {MAX_KEYS_PER_TOURNAMENT} competidores por torneo", code="PUSH_TOO_MANY")
    wanted &= valid_keys(db, t) if wanted else set()
    current = {
        f.person_key: f
        for f in db.scalars(
            select(PushFollow).where(
                PushFollow.subscription_id == sub.id,
                PushFollow.tournament_id == t.id,
                PushFollow.person_key.is_not(None),
            )
        ).all()
    }
    for key, f in current.items():
        if key not in wanted:
            db.delete(f)
    now, expires = utcnow(), follow_expiry(t)
    for key in wanted - set(current):
        db.add(
            PushFollow(subscription_id=sub.id, tournament_id=t.id, person_key=key, created_at=now, expires_at=expires)
        )
    db.commit()
    return sub


def can_follow_person(db: Session, user: User, person_id: int) -> bool:
    """El propio perfil, un menor a cargo (tutela verificada) o un alumno de su dojo (sensei)."""
    if user.is_admin or user.person_id == person_id:
        return True
    if db.scalar(select(Guardianship.id).where(Guardianship.user_id == user.id, Guardianship.person_id == person_id)):
        return True
    from app.services import people
    from app.services.claims import reviewer_dojo_ids

    dojos = reviewer_dojo_ids(db, user)
    if not dojos:
        return False
    m = people.current_membership(db, person_id)
    return m is not None and m.dojo_id in dojos


def can_follow_dojo(db: Session, user: User, dojo_id: int) -> bool:
    from app.services.claims import reviewer_dojo_ids

    return user.is_admin or dojo_id in reviewer_dojo_ids(db, user)


def follow_account(db: Session, user: User, data: PushAccountFollowIn) -> PushSubscription:
    """Seguir (o dejar de seguir) un perfil o un dojo desde la cuenta, en este dispositivo."""
    if (data.person_id is None) == (data.dojo_id is None):
        raise Conflict("Indica una persona o un dojo", code="PUSH_TARGET")
    sub = get_subscription(db, data.endpoint, data.auth)
    if sub.user_id != user.id:
        if sub.user_id is not None:
            _drop_account_follows(db, sub)
        sub.user_id = user.id
    if data.person_id is not None:
        if not can_follow_person(db, user, data.person_id):
            raise Forbidden("Solo puedes seguir tu perfil, el de tu familia o el de tus alumnos")
        where = PushFollow.person_id == data.person_id
    else:
        assert data.dojo_id is not None
        if not can_follow_dojo(db, user, data.dojo_id):
            raise Forbidden("Solo el sensei o el administrador del dojo lo sigue entero")
        where = PushFollow.dojo_id == data.dojo_id
    existing = db.scalars(select(PushFollow).where(PushFollow.subscription_id == sub.id, where)).all()
    if data.follow and not existing:
        count = len(
            db.scalars(
                select(PushFollow.id).where(PushFollow.subscription_id == sub.id, PushFollow.person_key.is_(None))
            ).all()
        )
        if count >= MAX_ACCOUNT_FOLLOWS:
            raise Conflict(f"Máximo {MAX_ACCOUNT_FOLLOWS} perfiles por dispositivo", code="PUSH_TOO_MANY")
        db.add(PushFollow(subscription_id=sub.id, person_id=data.person_id, dojo_id=data.dojo_id, created_at=utcnow()))
    elif not data.follow:
        for f in existing:
            db.delete(f)
    db.commit()
    return sub


# ---------------------------------------------------------------------------
# Encolar
# ---------------------------------------------------------------------------


def outbox_row(
    sub_id: int,
    kind: str,
    ref: str,
    title: str,
    body: str,
    url: str,
    *,
    tournament_id: int | None = None,
    ttl: int = 3600,
    urgency: str = "normal",
    tag: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Fila de ``notification_outbox`` (dict para insertar en lote). Vence a los ``ttl`` segundos."""
    now = now or utcnow()
    return {
        "subscription_id": sub_id,
        "tournament_id": tournament_id,
        "kind": kind,
        "ref": ref[:60],
        "title": title[:200],
        "body": body[:500],
        "url": url[:500],
        "tag": (tag or f"hajime-{kind}-{ref}")[:80],
        "ttl": ttl,
        "urgency": urgency,
        "status": "pending",
        "attempts": 0,
        "created_at": now,
        "next_attempt_at": now,
        "expires_at": now + timedelta(seconds=ttl),
    }


def notify_users(
    db: Session,
    user_ids: Iterable[int | None],
    kind: str,
    ref: str,
    title: str,
    body: str,
    url: str,
    ttl: int = 86400,
) -> int:
    """Aviso de cuenta a todos los dispositivos de esas cuentas (sin confirmar: va en la
    transacción de quien llama). Deduplicado por (suscripción, tipo, ref)."""
    ids = sorted({u for u in user_ids if u})
    if not ids or not enabled():
        return 0
    subs = db.execute(
        select(PushSubscription.id, PushSubscription.preferences).where(PushSubscription.user_id.in_(ids))
    ).all()
    targets = [sid for sid, prefs in subs if wants(prefs, kind)]
    if not targets:
        return 0
    done = set(
        db.scalars(
            select(NotificationOutbox.subscription_id).where(
                NotificationOutbox.subscription_id.in_(targets),
                NotificationOutbox.kind == kind,
                NotificationOutbox.ref == ref[:60],
            )
        ).all()
    )
    now = utcnow()
    n = 0
    for sid in targets:
        if sid not in done:
            db.add(NotificationOutbox(**outbox_row(sid, kind, ref, title, body, url, ttl=ttl, now=now)))
            n += 1
    if n:
        wake()
    return n


# ---------------------------------------------------------------------------
# Envío
# ---------------------------------------------------------------------------


def payload(row: NotificationOutbox) -> bytes:
    """Formato del service worker de Angular (``ngsw``): muestra la notificación y, al
    tocarla, abre la URL aunque la app esté cerrada (``onActionClick``)."""
    url = row.url or "/"
    data = {
        "notification": {
            "title": row.title,
            "body": row.body,
            "icon": ICON,
            "badge": BADGE,
            "lang": "es",
            "tag": row.tag or f"hajime-{row.id}",
            "renotify": row.kind in ("soon", "next"),
            "requireInteraction": row.kind == "next",
            "timestamp": int(row.created_at.timestamp() * 1000) if row.created_at else None,
            "data": {
                "url": url,
                "kind": row.kind,
                "onActionClick": {"default": {"operation": "navigateLastFocusedOrOpen", "url": url}},
            },
        }
    }
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()


def backoff(attempts: int) -> timedelta:
    """5 s, 10 s, 20 s… hasta 5 min (los avisos de turno vencen a los 10 min)."""
    return timedelta(seconds=min(300, 5 * 2 ** max(0, attempts - 1)))


def _ready(now: datetime):
    return or_(
        and_(NotificationOutbox.status == "pending", NotificationOutbox.next_attempt_at <= now),
        and_(NotificationOutbox.status == "sending", NotificationOutbox.locked_until < now),
    )


def _topic(row: NotificationOutbox) -> str | None:
    # Topic: el servicio de push reemplaza un aviso de turno aún no entregado por el más nuevo.
    if row.kind in ("soon", "next"):
        return "t" + "".join(ch for ch in row.ref if ch.isalnum())[:30]
    return None


def dispatch_once(session_factory: sessionmaker[Session], limit: int = 100, s: Settings | None = None) -> int:
    """Envía hasta ``limit`` avisos listos. Devuelve cuántos aceptó el servicio de push."""
    s = s or get_settings()
    vapid = webpush.get_vapid(s)
    if vapid is None:
        return 0
    with session_factory() as db:
        now = utcnow()
        ids = db.scalars(
            select(NotificationOutbox.id).where(_ready(now)).order_by(NotificationOutbox.id).limit(limit)
        ).all()
        if not ids:
            db.commit()
            return 0
        owner = uuid.uuid4().hex
        db.execute(
            update(NotificationOutbox)
            .where(NotificationOutbox.id.in_(ids), _ready(now))
            .values(
                status="sending",
                claimed_by=owner,
                locked_until=now + timedelta(seconds=s.push_lease_seconds),
                attempts=NotificationOutbox.attempts + 1,
            )
            .execution_options(synchronize_session=False)
        )
        db.commit()
        rows = db.execute(
            select(NotificationOutbox, PushSubscription)
            .outerjoin(PushSubscription, PushSubscription.id == NotificationOutbox.subscription_id)
            .where(NotificationOutbox.claimed_by == owner, NotificationOutbox.status == "sending")
        ).all()
        todo = []
        for row, sub in rows:
            if sub is None:
                row.status, row.last_error = "failed", "Suscripción borrada"
            elif row.expires_at is not None and row.expires_at <= now:
                row.status = "expired"
            else:
                todo.append((row, sub))
        results = _send_all(vapid, todo, now, s)
        gone: set[int] = set()
        sent = 0
        for (row, sub), (status, detail) in zip(todo, results, strict=True):
            if status in (404, 410):  # el navegador canceló la suscripción: se borra (con sus avisos)
                gone.add(sub.id)
                continue
            row.locked_until = None
            if status is not None and 200 <= status < 300:
                row.status, row.sent_at, row.last_error = "sent", utcnow(), None
                sub.last_success_at, sub.failures = utcnow(), 0
                sent += 1
                continue
            row.last_error = (f"HTTP {status}: {detail}" if status is not None else detail)[:500]
            retry = status is None or status == 429 or status >= 500
            if retry and row.attempts < s.push_max_attempts:
                row.status = "pending"
                row.next_attempt_at = utcnow() + backoff(row.attempts)
                log.warning("Aviso %s falló (intento %s): %s", row.id, row.attempts, row.last_error)
            else:
                row.status = "failed"
                sub.failures = (sub.failures or 0) + 1
                log.error("Aviso %s descartado tras %s intentos: %s", row.id, row.attempts, row.last_error)
        if gone:
            log.info("Suscripciones push vencidas (404/410): %s", len(gone))
            db.flush()
            delete_subscriptions(db, gone)
        db.commit()
        return sent


def _send_all(
    vapid: webpush.Vapid, todo: list[tuple[NotificationOutbox, PushSubscription]], now: datetime, s: Settings
) -> list[tuple[int | None, str]]:
    """Los POST en paralelo (sin tocar la base desde los hilos)."""

    def one(item: tuple[NotificationOutbox, PushSubscription]) -> tuple[int | None, str]:
        row, sub = item
        ttl = row.ttl
        if row.expires_at is not None:
            ttl = max(0, min(ttl, int((row.expires_at - now).total_seconds())))
        try:
            return webpush.send(
                vapid,
                sub.endpoint,
                sub.p256dh,
                sub.auth,
                payload(row),
                ttl=ttl,
                urgency=row.urgency,
                topic=_topic(row),
                timeout=s.push_timeout,
            )
        except webpush.PushNetworkError as e:
            return None, f"Sin respuesta: {e}"
        except Exception as e:  # noqa: BLE001 - p. ej. claves corruptas: se registra y se reintenta
            return None, f"{type(e).__name__}: {e}"

    if len(todo) <= 1:
        return [one(x) for x in todo]
    with ThreadPoolExecutor(max_workers=min(8, len(todo)), thread_name_prefix="hajime-push-send") as pool:
        return list(pool.map(one, todo))


def drain(session_factory: sessionmaker[Session], s: Settings | None = None, max_rounds: int = 50) -> int:
    total = 0
    for _ in range(max_rounds):
        n = dispatch_once(session_factory, s=s)
        total += n
        if n == 0:
            break
    return total


def cleanup(db: Session, now: datetime | None = None) -> None:
    """Borra lo que ya no sirve: avisos viejos, favoritos vencidos y suscripciones anónimas sin nada que seguir."""
    now = now or utcnow()
    db.execute(
        delete(NotificationOutbox).where(
            NotificationOutbox.status.in_(("sent", "failed", "expired")),
            NotificationOutbox.created_at < now - timedelta(days=3),
        )
    )
    db.execute(delete(PushFollow).where(PushFollow.expires_at.is_not(None), PushFollow.expires_at < now))
    orphans = db.scalars(
        select(PushSubscription.id).where(
            PushSubscription.user_id.is_(None),
            PushSubscription.created_at < now - timedelta(days=2),
            ~select(PushFollow.id).where(PushFollow.subscription_id == PushSubscription.id).exists(),
        )
    ).all()
    delete_subscriptions(db, orphans)
    db.commit()


# ---------------------------------------------------------------------------
# Hilo de fondo: recorre los torneos que cambiaron y envía la bandeja
# ---------------------------------------------------------------------------

_wake = threading.Event()


def wake() -> None:
    """Despierta al despachador de este proceso (hay avisos nuevos o torneos por recorrer)."""
    _wake.set()


class PushService:
    """Un hilo por proceso: recorre los torneos cambiados (``push_eval``), hace una
    pasada por los torneos en curso cada ``push_sweep_seconds`` y envía la bandeja."""

    MIN_EVAL_INTERVAL = 1.0  # como mucho un recorrido por segundo y torneo
    CLEANUP_SECONDS = 600.0

    def __init__(self, session_factory: sessionmaker[Session], s: Settings | None = None):
        self.session_factory = session_factory
        self.s = s or get_settings()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_eval: dict[int, float] = {}
        self._last_sweep = 0.0
        self._last_cleanup = 0.0

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="hajime-push", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        _wake.set()
        if self._thread is not None:
            self._thread.join(timeout)

    def tick(self) -> None:
        from app.services import push_eval

        now = time.monotonic()
        due, later = set(), set()
        for tid in push_eval.take_pending():
            (later if now - self._last_eval.get(tid, 0.0) < self.MIN_EVAL_INTERVAL else due).add(tid)
        if later:
            push_eval.requeue(later)
        if now - self._last_sweep >= self.s.push_sweep_seconds:
            self._last_sweep = now
            with self.session_factory() as db:
                due |= set(push_eval.active_tournaments(db))
        for tid in due:
            self._last_eval[tid] = time.monotonic()
            try:
                with self.session_factory() as db:
                    push_eval.evaluate(db, tid)
            except Exception:  # noqa: BLE001 - un torneo con datos raros no detiene a los demás
                log.exception("No se pudieron calcular los avisos del torneo %s", tid)
        drain(self.session_factory, self.s, max_rounds=5)
        if now - self._last_cleanup >= self.CLEANUP_SECONDS:
            self._last_cleanup = now
            with self.session_factory() as db:
                cleanup(db)

    def _run(self) -> None:
        while not self._stop.is_set():
            _wake.clear()
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - p. ej. la base pausada: próxima vuelta
                log.exception("El despachador de avisos falló; reintenta en %s s", self.s.push_poll_seconds)
            from app.services import push_eval

            # Una pausa mínima: la mesa escribe varias veces por segundo y cada commit despierta al hilo.
            if self._stop.wait(0.25):
                break
            wait = self.MIN_EVAL_INTERVAL if push_eval.has_pending() else self.s.push_poll_seconds
            _wake.wait(wait)
