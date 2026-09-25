"""Chequeo de compatibilidad con SQL Server (Azure SQL) en toda la suite.

Las pruebas corren sobre SQLite, que acepta SQL que SQL Server rechaza
(p. ej. `WHERE users.is_admin IS 1`, generado por `.is_(True)`). Cada consulta
del ORM ejecutada por las pruebas se compila además con el dialecto de SQL
Server; si aparece una construcción que SQL Server no acepta, la suite falla.
"""

import re

import pytest
import sqlalchemy as sa
from sqlalchemy.dialects import mssql
from sqlalchemy.orm import Session

_MSSQL = mssql.dialect()
_NO_SQLSERVER = re.compile(r"\bIS (1|0|true|false)\b|\bLIMIT\b|NULLS (FIRST|LAST)|\bILIKE\b", re.I)
_problems: dict[str, None] = {}


@sa.event.listens_for(Session, "do_orm_execute")
def _check_mssql(state) -> None:
    try:
        sql = str(state.statement.compile(dialect=_MSSQL))
    except Exception as e:  # noqa: BLE001 - se reporta como problema
        _problems[f"no compila en SQL Server: {type(e).__name__}: {e}"[:300]] = None
        return
    if m := _NO_SQLSERVER.search(sql):
        _problems[f"«{m.group(0)}» en: {' '.join(sql.split())[:250]}"] = None


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    if _problems:
        print("\nConsultas incompatibles con SQL Server:")
        for p in _problems:
            print(" -", p)
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
