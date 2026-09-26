"""Vista previa al compartir un enlace público (WhatsApp, Facebook, Telegram…).

Los robots de vista previa no ejecutan JavaScript: leen el ``index.html`` tal
cual. Sin SSR, el backend (que ya sirve el frontend, ``main.mount_frontend``)
inyecta en el HTML el título, la descripción, la URL y la imagen de lo que se
comparte, solo en las rutas públicas:

* ``/t/<slug>`` y ``/t/<slug>/categoria/<id>``: el torneo (y la categoría);
* ``/competidor/<public_id>``: el nombre público de la persona (abreviado si es
  menor) y su dojo, como el perfil público;
* ``/ranking/<temporada>``: la temporada, si es pública.

Todo va escapado. El resultado se guarda 60 s por proceso y el navegador puede
guardarlo 60 s (``Cache-Control``). El ``/index.html`` que usa el service
worker no se toca: los usuarios con la app instalada siguen con su copia y la
página pone sus propias etiquetas al cargar (``share-meta.ts``).
"""

from __future__ import annotations

import html
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Category, RankingSeason, Tournament

TTL = 60.0
IMAGE = "/icons/icon-512x512.png"
MONTHS = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre",
          "noviembre", "diciembre")  # fmt: skip

_ROUTES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^t/([a-z0-9-]{1,80})/?$"), "tournament"),
    (re.compile(r"^t/([a-z0-9-]{1,80})/categoria/(\d{1,9})/?$"), "category"),
    (re.compile(r"^competidor/([A-Za-z0-9_-]{1,24})/?$"), "person"),
    (re.compile(r"^ranking/([A-Za-z0-9-]{1,80})/?$"), "ranking"),
]

_lock = threading.Lock()
_cache: dict[str, tuple[float, str | None]] = {}
_template: dict[str, tuple[float, str]] = {}


def clear() -> None:
    with _lock:
        _cache.clear()
        _template.clear()


def _day(d) -> str:
    return f"{d.day} de {MONTHS[d.month - 1]} de {d.year}"


def _tournament(db: Session, slug: str) -> Tournament | None:
    return db.scalar(select(Tournament).where(Tournament.public_slug == slug, Tournament.public_token.is_not(None)))


def _describe_tournament(t: Tournament) -> str:
    where = ", ".join(x for x in (t.venue, t.city) if x)
    return f"{_day(t.start_date)}{' · ' + where if where else ''}. Combates en vivo, horarios, llaves y resultados."


def meta_for(db: Session, path: str) -> dict[str, str] | None:
    """Título y descripción de una ruta pública, o None si no es una o no existe."""
    for pattern, kind in _ROUTES:
        m = pattern.match(path)
        if not m:
            continue
        if kind == "tournament":
            t = _tournament(db, m.group(1))
            return {"title": t.name, "description": _describe_tournament(t)} if t else None
        if kind == "category":
            t = _tournament(db, m.group(1))
            c = db.get(Category, int(m.group(2))) if t else None
            if c is None or c.tournament_id != t.id or c.status in ("merged", "cancelled", "empty"):
                return None
            return {"title": f"{c.name} · {t.name}", "description": f"Llave y resultados. {_describe_tournament(t)}"}
        if kind == "person":
            from app.api.errors import NotFound
            from app.services import claims

            try:
                p = claims.by_public_id(db, m.group(1))
            except NotFound:
                return None
            _, dojo = claims.dojo_name(db, p.id)
            name = claims.public_name(p)
            return {"title": name, "description": f"{dojo + ' · ' if dojo else ''}Medallas y torneos en Hajime."}
        if kind == "ranking":
            s = db.scalar(select(RankingSeason).where(RankingSeason.slug == m.group(1)))
            if s is None or not s.is_public:
                return None
            return {"title": f"Ranking {s.name}", "description": "Ranking por puntos de la temporada en Hajime."}
    return None


def _set_tag(doc: str, attr: str, key: str, content: str) -> str:
    """Reemplaza el ``content`` de una etiqueta meta o la agrega antes de ``</head>``."""
    value = html.escape(content, quote=True)
    pattern = re.compile(rf'(<meta\s+{attr}="{re.escape(key)}"\s+content=")[^"]*(")', re.I)
    if pattern.search(doc):
        return pattern.sub(lambda mm: mm.group(1) + value + mm.group(2), doc, count=1)
    return doc.replace("</head>", f'    <meta {attr}="{key}" content="{value}" />\n  </head>', 1)


def inject(doc: str, meta: dict[str, str], url: str, image: str) -> str:
    title = f"{meta['title']} · Hajime"
    doc = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", doc, count=1, flags=re.S)
    # La descripción del index.html ocupa varias líneas: se quita y se agrega la nueva.
    doc = re.sub(r'\s*<meta\s+name="description"[^>]*>', "", doc, count=1, flags=re.S)
    doc = _set_tag(doc, "name", "description", meta["description"])
    for key, value in (
        ("og:type", "website"),
        ("og:site_name", "Hajime"),
        ("og:title", meta["title"]),
        ("og:description", meta["description"]),
        ("og:url", url),
        ("og:image", image),
    ):
        doc = _set_tag(doc, "property", key, value)
    for key, value in (("twitter:card", "summary"), ("twitter:title", meta["title"])):
        doc = _set_tag(doc, "name", key, value)
    return doc


def _index(index: Path) -> str:
    mtime = index.stat().st_mtime
    with _lock:
        hit = _template.get(str(index))
    if hit and hit[0] == mtime:
        return hit[1]
    text = index.read_text(encoding="utf-8")
    # Prettier parte en varias líneas las etiquetas largas: se juntan para reemplazarlas.
    text = re.sub(r"<meta\s*\n\s*([^>]*?)\s*/>", lambda mm: "<meta " + " ".join(mm.group(1).split()) + " />", text)
    with _lock:
        _template[str(index)] = (mtime, text)
    return text


def render(index: Path, path: str, base_url: str, session: Callable[[], Any]) -> str | None:
    """HTML con las etiquetas de la ruta, o None si la ruta no es pública (se sirve el index normal)."""
    path = path.lstrip("/")
    if not any(p.match(path) for p, _ in _ROUTES):
        return None
    key = f"{base_url}|{path}"
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    with session() as db:
        meta = meta_for(db, path)
    out = inject(_index(index), meta, f"{base_url}/{path}", base_url + IMAGE) if meta else None
    with _lock:
        if len(_cache) > 1000:
            _cache.clear()
        _cache[key] = (now + TTL, out)
    return out


def is_public_path(path: str) -> bool:
    path = path.lstrip("/")
    return any(p.match(path) for p, _ in _ROUTES)


def session():
    """Sesión de base para ``render`` (misma que usan las instantáneas públicas)."""
    from app.services.public_snapshots import _session

    return _session()
