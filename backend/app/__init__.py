"""Hajime — API de torneos de karate."""

from importlib.metadata import PackageNotFoundError, version

try:
    # La versión única vive en /VERSION; scripts/version.py la copia a pyproject.toml.
    __version__ = version("hajime-api")
except PackageNotFoundError:  # código sin instalar (p. ej. PYTHONPATH=backend)
    __version__ = "0.0.0"
