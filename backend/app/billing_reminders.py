"""Avisos de vencimiento de planes (7 días y 1 día antes, y gracia).

    python -m app.billing_reminders

Encola los correos que tocan hoy (los envía el despachador de correo o
``python -m app.mail_worker``). Pensado para un Container Apps Job diario; el
hilo despachador de la API ya lo hace solo cada hora. Nunca repite un aviso.
"""

from __future__ import annotations

import logging

from app.config import get_settings
from app.db.base import get_engine, session_factory, wait_for_database
from app.observability import configure_logging
from app.services import billing_mail, entitlements

log = logging.getLogger("hajime.pagos")


def main() -> int:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    if not entitlements.payments_enabled():
        log.info("Cobros apagados (HAJIME_PAYMENTS_ENABLED=false): no hay avisos de vencimiento")
        return 0
    if entitlements.billing_mode() != "enforced":
        log.info("Marcha blanca: no hay avisos de vencimiento")
        return 0
    wait_for_database(get_engine())
    with session_factory()() as db:
        n = billing_mail.send_reminders(db)
    log.info("Avisos de vencimiento encolados: %s", n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
