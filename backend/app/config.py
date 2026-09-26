from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="HAJIME_", env_file=".env", extra="ignore")

    environment: str = "dev"  # dev | test | prod
    # SQL Server: mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+18+for+SQL+Server
    database_url: str = "sqlite:///./hajime.db"
    jwt_secret: str = "cambiar-en-produccion"
    # Secreto anterior durante una rotación: se sigue aceptando para verificar
    # (no para firmar), así nadie pierde la sesión al cambiar el secreto.
    jwt_previous_secret: str | None = None
    # Token de acceso corto; la app lo renueva sola con el token de renovación.
    access_token_minutes: int = 60
    refresh_token_days: int = 30
    # Orígenes permitidos para CORS. Sin configurar, en dev/test se aceptan los
    # de desarrollo (DEV_CORS_ORIGINS); en prod ninguno: allí la interfaz se
    # sirve desde la misma URL y los orígenes extra se declaran a propósito
    # (p. ej. los de la app del celular). Ver allowed_cors_origins().
    cors_origins: list[str] | None = None
    timezone: str = "America/Lima"
    # Instalación de un solo contenedor: carpeta con el frontend compilado.
    static_dir: str | None = None
    # Si no hay usuarios, crea el admin con esta contraseña al arrancar.
    admin_password: str | None = None
    admin_username: str = "admin"
    # Carga la plantilla base de categorías si no hay ninguna.
    load_base_template: bool = True
    # SQL Server: aplicar las migraciones al arrancar (SQLite siempre las aplica).
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
    # Actualización en vivo por SSE (GET /public/{token}/stream, ver
    # app.services.public_stream). Conexiones abiertas por proceso: pasado el
    # límite se responde 503 y el navegador sigue con el sondeo de siempre.
    public_sse_max_connections: int = 500
    # Cada cuánto el sondeo compartido del proceso mira la versión de la instantánea.
    public_sse_poll_seconds: float = 1.0
    # Mínimo entre dos vueltas del sondeo aunque una escritura lo despierte antes.
    public_sse_min_interval: float = 0.5
    # Comentario de latido: mantiene viva la conexión a través de proxies.
    public_sse_heartbeat_seconds: float = 15.0
    # Duración máxima de una conexión: el navegador se reconecta solo (EventSource).
    public_sse_max_seconds: float = 900.0
    # Archivo donde se genera y guarda un secreto JWT si no se configuró uno.
    secret_file: str | None = None

    # --- Arranque ---
    # Migrar la base y crear el admin/plantilla al iniciar cada proceso. Cómodo en
    # desarrollo (un proceso, SQLite). El contenedor lo pone en false porque su
    # entrypoint ya lo hizo una sola vez antes de levantar los procesos
    # (python -m app.prepare); si se deja en true con varios procesos, un candado
    # en la base evita que choquen (ver app/prepare.py).
    migrate_on_startup: bool = True

    # --- Contraseñas e inicio de sesión ---
    # Iteraciones de PBKDF2-SHA256. Cada inicio de sesión cuesta este trabajo de
    # CPU: con 390 000 eran ~0,4 s en medio vCPU, suficiente para que unos pocos
    # intentos por segundo saturen el servidor. 120 000 (~0,12 s) sigue muy por
    # encima de lo que cuesta un ataque en línea, que además está limitado por
    # el bloqueo de intentos. Al cambiarlo, los hashes se actualizan solos cuando
    # cada usuario vuelve a entrar.
    password_iterations: int = 120_000

    # --- Base de datos ---
    # Conexiones por proceso (SQL Server). Con 4 hilos por proceso sobran 6; el
    # desborde cubre picos. Azure SQL serverless limita las sesiones según los
    # vCore: 3 copias × 2 procesos × 10 = 60 conexiones como máximo.
    db_pool_size: int = 6
    db_max_overflow: int = 4
    # Segundos que una petición espera una conexión libre antes de responder 503.
    db_pool_timeout: float = 10.0

    # --- HTTP y observabilidad ---
    # /docs y /openapi.json. Sin configurar: visibles salvo en prod.
    expose_docs: bool | None = None
    log_level: str = "INFO"
    # json (una línea por evento, para Azure / Log Analytics) o text (lectura en consola).
    log_format: str = "json"

    # --- Correo transaccional (ver app/services/mail.py y docs/cuentas-y-correo.md) ---
    # console (registra en el log y guarda en memoria; dev y pruebas) | smtp | acs
    mail_provider: str = "console"
    # Remitente por defecto (SMTP y ACS). Con ACS debe ser un remitente verificado del dominio.
    mail_from: str = "Hajime <no-responder@localhost>"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    # Remitente propio de SMTP; sin configurar se usa mail_from.
    smtp_from: str | None = None
    smtp_starttls: bool = True
    smtp_timeout: float = 20.0
    # Azure Communication Services Email: https://<recurso>.communication.azure.com y su clave de acceso.
    acs_endpoint: str | None = None
    acs_access_key: str | None = None
    acs_sender: str | None = None  # p. ej. DoNotReply@<dominio verificado>
    # Despachador de la bandeja de salida (outbox_emails): hilo de fondo en cada proceso.
    # Con un Container Apps Job (python -m app.mail_worker) se puede apagar aquí.
    mail_dispatcher: bool = True
    mail_poll_seconds: float = 5.0
    mail_max_attempts: int = 6
    # Segundos que un proceso «reserva» un correo mientras lo envía (lease).
    mail_lease_seconds: int = 120
    # URL pública de la interfaz para los enlaces de los correos y el logo
    # (p. ej. https://hajime.example.com). Sin configurar: http://localhost:4200.
    public_url: str | None = None

    # --- Cuentas de competidor (docs/modelo-negocio.md, «Cuentas de competidor») ---
    # Registro abierto con correo. Apagado por defecto: se enciende a propósito.
    open_signup: bool = False
    # Reclamo de un adulto sobre su propio perfil con los 4 últimos dígitos del
    # documento que coinciden: se aprueba solo. Los menores siempre los revisa una persona.
    auto_approve_self_claim: bool = False
    # Aviso «Tus diplomas están listos» a la persona y a su apoderado (con correo)
    # al finalizar una categoría con podio. Apagado por defecto.
    notify_diplomas: bool = False
    # --- Planes y cobros (ver docs/organizaciones-y-planes.md) ---
    # marcha_blanca: toda cuenta tiene acceso completo (pruebas y marcha blanca).
    # enforced: cada función de pago exige una suscripción vigente de la
    # organización (o de la persona, para Competidor Plus).
    billing_mode: Literal["marcha_blanca", "enforced"] = "marcha_blanca"
    # Pasarela de pagos: manual (el Admin marca pagado), mercadopago o culqi.
    payment_provider: Literal["manual", "mercadopago", "culqi"] = "manual"
    # Días que una suscripción con pago rechazado o vencido conserva el acceso.
    billing_grace_days: int = 7
    # Retornos de la pasarela y URL de avisos: usan public_url (arriba); sin
    # configurar, la URL con la que llegó la petición.
    # Tiempo máximo de cada llamada a la pasarela o al proveedor de comprobantes.
    payment_http_timeout: float = 15.0
    # Tamaño máximo del cuerpo de un aviso (webhook) de la pasarela.
    webhook_max_bytes: int = 65_536
    # Secretos: SOLO por variables de entorno (o Key Vault). SecretStr evita que
    # aparezcan en repr() o en los logs.
    # Mercado Pago (Checkout Pro y preapproval): token de acceso y clave secreta de avisos.
    mp_access_token: SecretStr | None = None
    mp_webhook_secret: SecretStr | None = None
    mp_api_url: str = "https://api.mercadopago.com"
    # Culqi: llave secreta (servidor) y llave pública (Culqi Checkout en el navegador).
    culqi_secret_key: SecretStr | None = None
    culqi_public_key: str | None = None
    # Contraseña de la autenticación básica configurada en el aviso de Culqi (opcional).
    culqi_webhook_secret: SecretStr | None = None
    culqi_api_url: str = "https://api.culqi.com"
    # Planes recurrentes creados en el panel de Culqi: {"dojo:month": "pln_live_…"}.
    culqi_plan_ids: dict[str, str] = {}

    # --- Comprobantes electrónicos (SUNAT) ---
    # none: no se emiten; nubefact: API JSON de Nubefact (OSE/PSE).
    invoicing_provider: Literal["none", "nubefact"] = "none"
    nubefact_url: SecretStr | None = None  # la «ruta» de la cuenta: identifica al emisor
    nubefact_token: SecretStr | None = None
    nubefact_serie_boleta: str = "BBB1"
    nubefact_serie_factura: str = "FFF1"
    # Notas de crédito: serie que empieza con la letra del comprobante que anulan
    # (F para facturas, B para boletas); la numeración es propia del tipo.
    nubefact_serie_nc_boleta: str = "BBB1"
    nubefact_serie_nc_factura: str = "FFF1"

    def allowed_cors_origins(self) -> list[str]:
        if self.cors_origins is not None:
            return self.cors_origins
        return [] if self.environment == "prod" else list(DEV_CORS_ORIGINS)

    def docs_enabled(self) -> bool:
        return self.expose_docs if self.expose_docs is not None else self.environment != "prod"

    def frontend_url(self) -> str:
        """Base de los enlaces que van en los correos (sin barra final)."""
        return (self.public_url or "http://localhost:4200").rstrip("/")


DEFAULT_SECRET = "cambiar-en-produccion"
# El servidor de desarrollo de Angular y la app del celular (Capacitor sirve la
# interfaz desde localhost con su propio esquema).
DEV_CORS_ORIGINS = (
    "http://localhost:4200",
    "https://localhost",
    "http://localhost",
    "capacitor://localhost",
)


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
