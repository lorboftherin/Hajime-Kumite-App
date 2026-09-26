"""Llena la plantilla de inscripciones descargada de la app (pruebas e2e).

    python llenar_plantilla.py <entrada.xlsx> <salida.xlsx> '<filas en JSON>'

Cada fila es un objeto con las columnas de la plantilla por su nombre corto
(dojo, nombres, apellidos, nacimiento, sexo, grado, peso, modalidades). Se
borra la fila de ejemplo y se escriben las filas desde la segunda. Usa
openpyxl, que ya es dependencia del backend.
"""

import json
import sys

from openpyxl import load_workbook

# Prefijo del encabezado de cada columna en la plantilla -> clave de la fila.
COLUMNAS = {
    "Dojo": "dojo",
    "Nombres": "nombres",
    "Apellidos": "apellidos",
    "Fecha nacimiento": "nacimiento",
    "Sexo": "sexo",
    "Grado": "grado",
    "Categoría de peso": "peso",
    "Modalidades": "modalidades",
}


def main() -> None:
    entrada, salida, filas = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    wb = load_workbook(entrada)
    ws = wb["Inscripciones"]
    indices = {}
    for celda in ws[1]:
        for prefijo, clave in COLUMNAS.items():
            if isinstance(celda.value, str) and celda.value.startswith(prefijo):
                indices[clave] = celda.column
    faltan = set(COLUMNAS.values()) - set(indices)
    if faltan:
        raise SystemExit(f"La plantilla no tiene las columnas {sorted(faltan)}")
    ws.delete_rows(2, ws.max_row)
    for n, fila in enumerate(filas, start=2):
        for clave, valor in fila.items():
            ws.cell(row=n, column=indices[clave], value=valor)
    wb.save(salida)


if __name__ == "__main__":
    main()
