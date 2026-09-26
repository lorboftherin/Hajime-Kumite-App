"""Avisos push fuera de la API: recorre los torneos en curso y envía la bandeja.

    python -m app.push_worker            # una pasada: recorre, envía lo pendiente y termina
    python -m app.push_worker --loop     # se queda trabajando (como el hilo de la API)

Puede correr a la vez que el hilo de avisos de cada proceso de la API: los
avisos se deduplican por (suscripción, tipo, combate) y cada lote se reserva
con un UPDATE condicional, así que ninguno sale dos veces. Este proceso no ve
los commits de la API al instante: recorre los torneos en curso cada
``HAJIME_PUSH_SWEEP_SECONDS`` (y en cada pasada sin ``--loop``).
"""

from __future__ import annotations

import argparse
import logging
import signal
import threading

from app.config import get_settings
from app.db.base import get_engine, session_factory, wait_for_database
from app.observability import configure_logging
from app.services import push, push_eval

log = logging.getLogger("hajime.push")


def run_once(factory, settings) -> int:
    """Recorre los torneos en curso y envía lo pendiente. Devuelve cuántos avisos se enviaron."""
    with factory() as db:
        tids = push_eval.active_tournaments(db)
    for tid in tids:
        try:
            with factory() as db:
                push_eval.evaluate(db, tid)
        except Exception:  # noqa: BLE001 - un torneo con datos raros no detiene a los demás
            log.exception("No se pudieron calcular los avisos del torneo %s", tid)
    sent = push.drain(factory, settings)
    with factory() as db:
        push.cleanup(db)
    return sent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Despachador de avisos push de Hajime")
    parser.add_argument("--loop", action="store_true", help="seguir trabajando (no terminar)")
    args = parser.parse_args(argv)
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    if not push.enabled(settings):
        log.warning("Faltan HAJIME_VAPID_PUBLIC_KEY y HAJIME_VAPID_PRIVATE_KEY: avisos apagados")
        return 0
    wait_for_database(get_engine())
    factory = session_factory()
    if not args.loop:
        log.info("Avisos enviados: %s", run_once(factory, settings))
        return 0
    service = push.PushService(factory, settings)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.is_set():
        try:
            service.tick()
        except Exception:  # noqa: BLE001 - base pausada o servicio de push caído: próxima vuelta
            log.exception("El despachador de avisos falló")
        stop.wait(settings.push_poll_seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
