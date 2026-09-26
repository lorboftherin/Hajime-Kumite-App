"""Envía los correos pendientes de la bandeja de salida (``outbox_emails``).

    python -m app.mail_worker            # envía lo pendiente y termina (Container Apps Job programado)
    python -m app.mail_worker --loop     # se queda revisando cada HAJIME_MAIL_POLL_SECONDS

Puede correr a la vez que el hilo despachador de la API: cada correo se
reserva con un UPDATE condicional, así que ninguno sale dos veces.
"""

from __future__ import annotations

import argparse
import logging
import signal
import threading

from app.config import get_settings
from app.db.base import get_engine, session_factory, wait_for_database
from app.observability import configure_logging
from app.services import mail

log = logging.getLogger("hajime.mail")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Despachador de correo de Hajime")
    parser.add_argument("--loop", action="store_true", help="seguir revisando la bandeja (no terminar)")
    args = parser.parse_args(argv)
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    wait_for_database(get_engine())
    factory = session_factory()
    if not args.loop:
        n = mail.drain(factory, settings)
        log.info("Correos enviados: %s", n)
        return 0
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.is_set():
        try:
            mail.drain(factory, settings)
        except Exception:  # noqa: BLE001 - base pausada o proveedor caído: próxima vuelta
            log.exception("El despachador de correo falló")
        stop.wait(settings.mail_poll_seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
