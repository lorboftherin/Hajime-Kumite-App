from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="HAJIME_", env_file=".env", extra="ignore")

    environment: str = "dev"  # dev | test | prod
    # SQL Server: mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+18+for+SQL+Server
    database_url: str = "sqlite:///./hajime.db"
    jwt_secret: str = "cambiar-en-produccion"
    jwt_minutes: int = 12 * 60
    # Orígenes permitidos: el servidor de desarrollo de Angular y la app del
    # celular (Capacitor sirve la interfaz desde localhost con su propio esquema).
    cors_origins: list[str] = [
        "http://localhost:4200",
        "https://localhost",
        "http://localhost",
        "capacitor://localhost",
    ]
    timezone: str = "America/Lima"
    # Instalación de un solo contenedor: carpeta con el frontend compilado.
    static_dir: str | None = None
    # Si no hay usuarios, crea el admin con esta contraseña al arrancar.
    admin_password: str | None = None
    admin_username: str = "admin"
    # Carga la plantilla base de categorías si no hay ninguna.
    load_base_template: bool = True
    # SQL Server: crear tablas al arrancar (SQLite siempre las crea).
    auto_create_schema: bool = False
    # Hilos que atienden peticiones a la vez en cada proceso. Pocos hilos rinden más:
    # con 40 (el valor por defecto de FastAPI) el intérprete pierde el tiempo pasando
    # de uno a otro (medido: 3 veces menos peticiones por segundo). Para usar más de
    # un núcleo se levantan varios procesos (HAJIME_WORKERS en el contenedor).
    worker_threads: int = 4
    # Vivo público (ver app.services.public_snapshots). Segundos que el navegador
    # reutiliza la respuesta sin preguntar (max-age); después pregunta con ETag y
    # recibe 304 si nada cambió. 0 = sin caché: se calcula en cada petición.
    public_cache_seconds: float = 3.0
    # Edad máxima de la instantánea guardada en la base aunque nadie la haya
    # invalidado (red de seguridad para cambios que no pasan por invalidate()).
    public_snapshot_max_age: float = 30.0
    # Hilos propios para /public: el vivo nunca ocupa los hilos de las mesas.
    public_threads: int = 2
    # Archivo donde se genera y guarda un secreto JWT si no se configuró uno.
    secret_file: str | None = None


DEFAULT_SECRET = "cambiar-en-produccion"


def _load_or_create_secret(path: str) -> str:
    import secrets
    from pathlib import Path

    f = Path(path)
    if f.exists() and f.read_text().strip():
        return f.read_text().strip()
    f.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(48)
    f.write_text(value)
    f.chmod(0o600)
    return value


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.jwt_secret == DEFAULT_SECRET and s.secret_file:
        s.jwt_secret = _load_or_create_secret(s.secret_file)
    return s
