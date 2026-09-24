"""Genera sql/001_schema.sql (SQL Server / Azure SQL) a partir de los modelos.

    python scripts/export_ddl.py

El script resultante se versiona y se aplica con sqlcmd o Azure Data Studio.
Cuando el esquema empiece a cambiar con datos reales, migrar a Alembic.
"""

from pathlib import Path

from sqlalchemy.dialects import mssql
from sqlalchemy.schema import AddConstraint, CreateIndex, CreateTable

import app.db.models  # noqa: F401
from app.db.base import Base

OUT = Path(__file__).resolve().parents[2] / "sql" / "001_schema.sql"


def main() -> None:
    dialect = mssql.dialect()
    dialect.server_version_info = (16, 0)  # SQL Server 2022 / Azure SQL
    dialect._setup_version_attributes()
    parts = ["-- Generado por backend/scripts/export_ddl.py. No editar a mano.", "SET XACT_ABORT ON;", "BEGIN TRAN;", ""]
    deferred = []
    for table in Base.metadata.sorted_tables:
        parts.append(str(CreateTable(table).compile(dialect=dialect)).strip() + ";\n")
        for idx in sorted(table.indexes, key=lambda i: i.name or ""):
            parts.append(str(CreateIndex(idx).compile(dialect=dialect)).strip() + ";")
        for fk in table.foreign_key_constraints:
            if fk.use_alter:
                deferred.append(fk)
    for fk in deferred:
        parts.append(str(AddConstraint(fk).compile(dialect=dialect)).strip() + ";")
    parts += ["", "COMMIT;"]
    OUT.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print(f"Escrito {OUT}")


if __name__ == "__main__":
    main()
