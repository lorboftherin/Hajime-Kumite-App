from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="HAJIME_", env_file=".env", extra="ignore")

    environment: str = "dev"  # dev | test | prod
    # SQL Server: mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+18+for+SQL+Server
    database_url: str = "sqlite:///./hajime.db"
    jwt_secret: str = "cambiar-en-produccion"
    jwt_minutes: int = 12 * 60
    cors_origins: list[str] = ["http://localhost:4200"]
    timezone: str = "America/Lima"


@lru_cache
def get_settings() -> Settings:
    return Settings()
