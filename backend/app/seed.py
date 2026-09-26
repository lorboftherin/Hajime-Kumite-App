"""Datos iniciales.

    python -m app.seed admin --username admin --password <clave>
    python -m app.seed template          # plantilla base de categorías (borrador)
    python -m app.seed demo              # torneo mock con datos FICTICIOS
    python -m app.seed purge-imports     # borra filas de importaciones de más de 30 días
    python -m app.seed vapid-keys        # genera las claves VAPID de los avisos push (no toca la base)

La plantilla es un punto de partida editable: su contenido (edades, pesos,
grados) es una decisión abierta del documento maestro (sección 30).
"""

from __future__ import annotations

import argparse
import getpass
import os
import random
from datetime import date

from sqlalchemy import select

import app.db.models  # noqa: F401
from app.api import schemas as s
from app.config import get_settings
from app.db.base import get_engine, get_session
from app.db.models import CategoryTemplate, User
from app.domain.categories import grade_to_ordinal
from app.security import hash_password
from app.services import people, registrations, tournaments

BEGINNER = (grade_to_ordinal("10 kyu"), grade_to_ordinal("7 kyu"))
ADVANCED = (grade_to_ordinal("6 kyu"), None)

WEIGHTS = {
    ("12-13", "M"): ["-40", "-45", "-50", "-55", "+55"],
    ("12-13", "F"): ["-42", "-47", "+47"],
    ("14-15", "M"): ["-52", "-57", "-63", "-70", "+70"],
    ("14-15", "F"): ["-47", "-54", "+54"],
    ("16-17", "M"): ["-55", "-61", "-68", "-76", "+76"],
    ("16-17", "F"): ["-48", "-53", "-59", "-66", "+66"],
    ("18+", "M"): ["-60", "-67", "-75", "-84", "+84"],
    ("18+", "F"): ["-50", "-55", "-61", "-68", "+68"],
}
AGE = {
    "6-7": (6, 7),
    "8-9": (8, 9),
    "10-11": (10, 11),
    "12-13": (12, 13),
    "14-15": (14, 15),
    "16-17": (16, 17),
    "18+": (18, None),
}
LABEL = {
    "6-7": "6-7 años",
    "8-9": "8-9 años",
    "10-11": "10-11 años",
    "12-13": "12-13 años",
    "14-15": "Cadete 14-15",
    "16-17": "Junior 16-17",
    "18+": "Senior 18+",
}
DURATION = {"6-7": 60, "8-9": 60, "10-11": 90, "12-13": 90, "14-15": 120, "16-17": 120, "18+": 180}
SEX = {"M": "Masculino", "F": "Femenino"}


def base_template_items() -> list[s.CategoryFields]:
    items: list[s.CategoryFields] = []
    order = 0

    def add(**kw):
        nonlocal order
        order += 1
        items.append(s.CategoryFields(sort_order=order, **kw))

    for group in ("6-7", "8-9", "10-11"):
        amin, amax = AGE[group]
        for sex in ("M", "F"):
            for band, (gmin, gmax), bl in (("P", BEGINNER, "10-7 kyu"), ("A", ADVANCED, "6 kyu+")):
                for mod in ("kata", "kumite"):
                    add(
                        code=f"{mod[:2].upper()}-{group}-{sex}-{band}",
                        name=f"{mod.capitalize()} {LABEL[group]} {SEX[sex]} {bl}",
                        modality=mod,
                        sex=sex,
                        age_min=amin,
                        age_max=amax,
                        grade_min=gmin,
                        grade_max=gmax,
                        duration_seconds=DURATION[group] if mod == "kumite" else None,
                        kata_method="flags" if mod == "kata" else None,
                    )
    for group in ("12-13", "14-15", "16-17", "18+"):
        amin, amax = AGE[group]
        for sex in ("M", "F"):
            add(
                code=f"KA-{group}-{sex}",
                name=f"Kata {LABEL[group]} {SEX[sex]}",
                modality="kata",
                sex=sex,
                age_min=amin,
                age_max=amax,
                kata_method="flags",
            )
            for w in WEIGHTS[(group, sex)]:
                add(
                    code=f"KU-{group}-{sex}{w}",
                    name=f"Kumite {LABEL[group]} {SEX[sex]} {w} kg",
                    modality="kumite",
                    sex=sex,
                    age_min=amin,
                    age_max=amax,
                    weight_class=w,
                    duration_seconds=DURATION[group],
                )
    return items


def ensure_schema() -> None:
    if get_engine().url.get_backend_name() == "sqlite":
        from app.db.migrate import upgrade_database

        upgrade_database(get_engine())


def cmd_admin(username: str, password: str, force: bool = False) -> None:
    db = next(get_session())
    u = db.scalar(select(User).where(User.username == username.lower()))
    if u:
        if not force:
            raise SystemExit(f"El usuario {username} ya existe; use --force para cambiar su contraseña")
        u.password_hash = hash_password(password)
        u.is_admin = True
        print(f"Contraseña actualizada para {username}")
    else:
        db.add(
            User(username=username.lower(), password_hash=hash_password(password), is_admin=True, display_name=username)
        )
        print(f"Admin {username} creado")
    db.commit()


def _admin(db) -> User:
    u = db.scalar(select(User).where(User.is_admin))
    if u is None:
        raise SystemExit("Primero crea un admin: python -m app.seed admin --username admin --password ...")
    return u


def cmd_template() -> int:
    db = next(get_session())
    existing = db.scalar(select(CategoryTemplate).where(CategoryTemplate.name == "Plantilla base (borrador)"))
    if existing:
        print(f"Ya existe la plantilla base (id {existing.id})")
        return existing.id
    t = tournaments.create_template(
        db,
        _admin(db),
        s.TemplateCreate(
            name="Plantilla base (borrador)",
            description="Punto de partida editable. Edades, pesos y grados por confirmar (decisión abierta).",
            items=base_template_items(),
        ),
    )
    print(f"Plantilla base creada (id {t.id}, {len(t.items)} categorías)")
    return t.id


FIRST_M = ["Mateo", "Santiago", "Thiago", "Sebastián", "Diego", "Joaquín", "Gael", "Adrián", "Lucas", "Bruno"]
FIRST_F = ["Valentina", "Camila", "Luciana", "Mía", "Ariana", "Isabella", "Renata", "Fernanda", "Zoe", "Antonella"]
LAST = [
    "Quispe",
    "Flores",
    "Rojas",
    "Huamán",
    "Mendoza",
    "Castillo",
    "Vargas",
    "Chávez",
    "Torres",
    "Ramírez",
    "Paredes",
    "Salazar",
]


def cmd_demo() -> None:
    if get_settings().environment not in ("dev", "test"):
        raise SystemExit("Los datos de demostración solo se cargan en DEV o TEST (sección 11: datos de prueba)")
    db = next(get_session())
    admin = _admin(db)
    tpl_id = cmd_template()
    rng = random.Random(2026)
    dojos = [
        people.create_dojo(db, admin, s.DojoCreate(name=n, short_name=sn, city="Lima"))
        for n, sn in (
            ("Dojo Ficticio Shotokan San Isidro", "DFS"),
            ("Academia Ficticia Goju Miraflores", "AFG"),
            ("Club Ficticio Wado Surco", "CFW"),
            ("Dojo Ficticio Shito Callao", "DFSC"),
        )
    ]
    t = tournaments.create_tournament(
        db,
        admin,
        s.TournamentCreate(
            name="Torneo mock — entrenamiento",
            start_date=date(2026, 10, 17),
            venue="Dojo de entrenamiento",
            city="Lima",
            is_test=True,
            template_id=tpl_id,
            tatami_count=1,
        ),
    )
    t = tournaments.change_status(db, admin, t.id, s.StatusChange(status="registration_open", version=t.version))
    grades = ["9 kyu", "8 kyu", "7 kyu", "6 kyu", "5 kyu"]
    n = 0
    for i in range(32):
        sex = "M" if i % 3 else "F"
        first = rng.choice(FIRST_M if sex == "M" else FIRST_F)
        last = f"{rng.choice(LAST)} {rng.choice(LAST)}"
        dojo = dojos[0] if i % 2 == 0 else rng.choice(dojos[1:])  # un dojo con mitad de los alumnos
        birth = date(2016 + (i % 2), rng.randint(1, 12), rng.randint(1, 28))  # 8-10 años
        p = people.create_person(
            db,
            admin,
            is_test_data=True,
            data=s.PersonCreate(
                first_names=first,
                last_names=last,
                birth_date=birth,
                sex=sex,
                dojo_id=dojo.id,
                grade=rng.choice(grades[:3]),
                override=s.Override(reason="Datos ficticios de demostración"),
            ),
        )
        for sug in registrations.suggestions(db, t.id, p.id):
            registrations.create_registration(db, admin, t.id, s.RegistrationCreate(person_id=p.id, category_id=sug.id))
            n += 1
    print(f"Torneo mock creado (id {t.id}) con {n} inscripciones ficticias")


def cmd_purge_imports(days: int) -> None:
    db = next(get_session())
    try:
        r = registrations.purge_old_imports(db, days)
    finally:
        db.close()
    print(
        f"Importaciones de más de {days} días: {r['batches']} lotes, {r['rows']} filas borradas, "
        f"{r['expired_previews']} vistas previas vencidas"
    )


def cmd_vapid_keys() -> None:
    """Imprime un par de claves VAPID nuevo para los avisos push (docs/avisos-push.md)."""
    from app.services.webpush import generate_vapid_keys

    public_key, private_key = generate_vapid_keys()
    print("# Claves VAPID de los avisos push. La privada es un SECRETO (Key Vault / secreto del Container App).")
    print("# Cambiarlas invalida todas las suscripciones: los navegadores tienen que volver a suscribirse.")
    print(f"HAJIME_VAPID_PUBLIC_KEY={public_key}")
    print(f"HAJIME_VAPID_PRIVATE_KEY={private_key}")
    print("HAJIME_VAPID_SUBJECT=mailto:soporte@tu-dominio.pe")


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m app.seed")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("admin")
    a.add_argument("--username", default="admin")
    a.add_argument("--password", help="Si se omite, se lee de HAJIME_ADMIN_PASSWORD o se pide por consola")
    a.add_argument("--force", action="store_true", help="Cambiar la contraseña si el usuario ya existe")
    sub.add_parser("template")
    sub.add_parser("demo")
    pi = sub.add_parser("purge-imports", help="Borra las filas de importaciones antiguas (DNI, fechas)")
    pi.add_argument("--days", type=int, default=registrations.IMPORT_RETENTION_DAYS)
    sub.add_parser("vapid-keys", help="Genera las claves VAPID de los avisos push (no toca la base)")
    args = ap.parse_args()
    if args.cmd == "vapid-keys":
        cmd_vapid_keys()
        return
    ensure_schema()
    if args.cmd == "admin":
        password = args.password or os.environ.get("HAJIME_ADMIN_PASSWORD") or getpass.getpass("Contraseña: ")
        if len(password) < 8:
            raise SystemExit("La contraseña debe tener al menos 8 caracteres")
        cmd_admin(args.username, password, args.force)
    elif args.cmd == "template":
        cmd_template()
    elif args.cmd == "purge-imports":
        cmd_purge_imports(args.days)
    else:
        cmd_demo()


if __name__ == "__main__":
    main()
