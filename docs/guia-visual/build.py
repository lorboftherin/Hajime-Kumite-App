"""Arma guia-hajime.html: incrusta capturas (JPEG) y genera pasos, galería y mesa."""

import html
import json
import re
from pathlib import Path

import pymupdf

HERE = Path(__file__).parent
SHOTS = Path("/home/user/Hajime-Kumite-App/docs/screenshots")
ENSO_SRC = Path("/home/user/Hajime-Kumite-App/frontend/src/app/shared/enso.ts").read_text()
def _const(name: str) -> str:
    return re.search(rf"{name} =\s*'([^']+)'", ENSO_SRC).group(1)


ENSO_AKA, ENSO_AO = _const("ENSO_AKA"), _const("ENSO_AO")
HAJIME_WORD, HAJIME_WORD_VIEWBOX = _const("HAJIME_WORD"), _const("HAJIME_WORD_VIEWBOX")
# Logotipo en color (aka en shu, ao en ai) y versión en tinta para fondos decorativos.
ENSO = (
    '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
    f'<path d="{ENSO_AKA}" fill="#BE3B2C"/><path d="{ENSO_AO}" fill="var(--logo-ao, #24477A)"/></svg>'
)
ENSO_MONO = (
    '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
    f'<path d="{ENSO_AKA}" fill="currentColor"/><path d="{ENSO_AO}" fill="currentColor"/></svg>'
)
WORD = (
    f'<svg class="word" viewBox="{HAJIME_WORD_VIEWBOX}" role="img" aria-label="Hajime">'
    f'<path d="{HAJIME_WORD}" fill="currentColor"/></svg>'
)

_cache: dict[str, str] = {}


IMG_DIR = HERE / "img"


def img(name: str) -> str:
    """Convierte la captura a JPEG en img/ y devuelve su ruta relativa."""
    if name not in _cache:
        IMG_DIR.mkdir(exist_ok=True)
        pix = pymupdf.Pixmap(str(SHOTS / name))
        if pix.alpha:
            pix = pymupdf.Pixmap(pix, 0)
        out = IMG_DIR / (Path(name).stem + ".jpg")
        out.write_bytes(pix.tobytes("jpg", jpg_quality=82))
        _cache[name] = f"img/{out.name}"
    return _cache[name]


def frame(name: str, cap: str, bar: bool = True) -> str:
    src = img(name)
    return (
        f'<button class="frame" type="button" data-full="{src}" data-cap="{html.escape(cap)}">'
        + ('<div class="bar"><b></b><b></b><b></b></div>' if bar else "")
        + f'<img src="{src}" alt="{html.escape(cap)}" loading="lazy"></button>'
    )


ROLE = {"admin": ("admin", "Admin"), "org": ("org", "Organizador"), "op": ("op", "Operador de mesa")}

STEPS = [
    {
        "tag": "Preparación",
        "title": "Crear el torneo",
        "shot": ("07-torneos.png", "Lista de torneos"),
        "desc": "En Torneos → Nuevo torneo. Elige la plantilla base de categorías y cuántos tatamis habrá. Para el mock, marca «Torneo de prueba»: no cuenta en el historial ni en estadísticas.",
        "how": [
            "Cambia el estado a «Inscripciones abiertas» desde la pestaña Resumen.",
            "La fecha de referencia de edad es el día del torneo; se puede cambiar y las edades se recalculan.",
        ],
        "who": ["admin", "org"],
    },
    {
        "tag": "Preparación",
        "title": "Inscribir: una por una o desde Excel",
        "shot": ("12-importar.png", "Vista previa de la importación Excel"),
        "desc": "Descarga la plantilla Excel, pásala a los dojos, y súbela en «Importar Excel». La vista previa marca cada fila como nueva, posible duplicado o con error. Nada se guarda hasta que confirmas.",
        "how": [
            "Para un posible duplicado, elige «usar existente» y se evita crear dos veces a la misma persona.",
            "La app sugiere las categorías que corresponden por edad, sexo, grado y peso.",
            "Si alguien no encaja (p. ej. un grado alto en principiantes), aparece una advertencia: se acepta con un motivo que queda registrado.",
        ],
        "who": ["admin", "org"],
        "tip": "El documento es opcional. Sin DNI la persona queda como «identidad incompleta» y se puede completar después.",
    },
    {
        "tag": "Preparación",
        "title": "Revisar y ajustar las categorías",
        "shot": ("10-categorias.png", "Pestaña Categorías"),
        "desc": "Las categorías sin inscritos quedan «Vacía». Para las que tienen pocos, la app sugiere fusionar, final directa o round robin; tú decides.",
        "how": [
            "Selecciona dos o más y pulsa «Fusionar»: los inscritos pasan a la nueva y las de origen quedan «Fusionada». Se puede deshacer mientras no haya combates.",
            "Asigna cada categoría a un tatami y su orden en la cola.",
        ],
        "who": ["admin", "org"],
    },
    {
        "tag": "Preparación",
        "title": "Generar, revisar e imprimir las llaves",
        "shot": ("02-llave.png", "Llave de eliminación directa"),
        "desc": "La llave separa a los competidores del mismo dojo en las primeras rondas y reparte los byes de forma pareja. Arriba ves cuántos cruces del mismo dojo quedaron en primera ronda.",
        "how": [
            "«Intercambiar» mueve a dos competidores de lugar; cada cambio guarda una versión nueva.",
            "«PDF» imprime la llave con los códigos de combate; «Más → PDF en blanco» para llenar a mano.",
            "Con la misma semilla sale la misma llave, así que se puede reproducir.",
        ],
        "who": ["admin", "org"],
    },
    {
        "tag": "Día del torneo",
        "title": "Ordenar los tatamis e imprimir la planilla",
        "shot": ("13-tatamis.png", "Pestaña Tatamis con la cola numerada"),
        "desc": "Cada tatami muestra el combate actual, el siguiente y los que esperan, numerados T1‑001, T1‑002… «Planilla PDF» imprime esa misma lista con casillas para el marcador oficial en papel.",
        "how": [
            "Si un competidor tiene combates pendientes en dos tatamis a la vez, aparece un aviso.",
            "«Abrir mesa» lleva a la mesa de ese combate.",
        ],
        "who": ["admin", "org", "op"],
        "tip": "En Shadow Mode la mesa oficial anota en la planilla y el operador en la app. Como ambos usan el mismo número de combate, la comparación final es directa.",
    },
    {
        "tag": "Día del torneo",
        "title": "Operar la mesa de kumite",
        "shot": ("03-mesa-kumite.png", "Mesa de kumite"),
        "desc": "HAJIME inicia el reloj y YAME lo detiene. Los botones +1, +2 y +3 marcan Yuko, Waza‑ari e Ippon; las marcas de tinta aplican las sanciones. Si algo sale mal, «Deshacer último» siempre está a mano.",
        "how": [
            "El reloj se detiene solo al marcar un punto (tiempo efectivo).",
            "La app sugiere el ganador (puntos, diferencia de 8, hansoku, senshu o hantei); al cerrar confirmas tú.",
            "Si se cae el Wi‑Fi, los toques se guardan en la tablet y se envían solos al volver, sin duplicarse.",
        ],
        "who": ["admin", "org", "op"],
    },
    {
        "tag": "Día del torneo",
        "title": "Kata: banderas o puntuación",
        "shot": ("15-kata-rondas.png", "Kata por puntuación en ronda única"),
        "desc": "Por banderas, la mesa marca el voto de cada juez y gana la mayoría. Por puntuación, se ingresan las notas de cada juez (5.0 a 10.0); se descartan la más alta y la más baja y se ordena el ranking.",
        "how": [
            "Los empates se resuelven primero por la nota mínima descartada y luego por la máxima.",
            "Si aún quedan empatados, el organizador registra el desempate con un motivo.",
        ],
        "who": ["admin", "org", "op"],
    },
    {
        "tag": "Cierre",
        "title": "Resultados y medallero",
        "shot": ("04-resultados.png", "Resultados por categoría y medallero por dojo"),
        "desc": "Cada categoría terminada muestra su podio con sellos 1, 2 y 3. El medallero ordena a los dojos por oros, luego platas y luego bronces. Se exporta a Excel y PDF.",
        "how": [
            "Corregir un ganador ya avanzado muestra qué combates siguientes se ven afectados y pide un motivo.",
            "Una categoría finalizada se puede reabrir sin reabrir el torneo completo.",
        ],
        "who": ["admin", "org"],
    },
    {
        "tag": "Cierre",
        "title": "Comparar con el papel (Shadow Mode)",
        "shot": ("14-shadow.png", "Reporte de comparación Shadow Mode"),
        "desc": "Carga el ganador y el marcador oficiales de la planilla. La app calcula el porcentaje de coincidencia y resalta cada diferencia, para anotar si el error fue de la app o del papel.",
        "how": [
            "Esa es la medida de éxito del documento maestro: 100 % tras correcciones y ≥ 95 % sin ellas.",
            "Todo cambio queda en Auditoría: quién, cuándo, antes, después y por qué.",
        ],
        "who": ["admin", "org"],
    },
]

GALLERY = [
    ("00-login.png", "Ingreso", "Pantalla de inicio de sesión."),
    ("07-torneos.png", "Torneos", "Lista de torneos, reales y de prueba."),
    ("01-torneo-detalle.png", "Resumen del torneo", "Estado, inscripciones y categorías de un vistazo."),
    ("10-categorias.png", "Categorías", "Estados, fusiones y asignación a tatamis."),
    ("11-inscripciones.png", "Inscripciones", "Inscripción manual con categorías sugeridas."),
    ("12-importar.png", "Importar Excel", "Vista previa fila por fila antes de guardar."),
    ("13-tatamis.png", "Tatamis", "Colas numeradas y planilla imprimible."),
    ("02-llave.png", "Llave", "Eliminación directa con separación por dojo."),
    ("03-mesa-kumite.png", "Mesa de kumite", "Marcador, reloj y sanciones."),
    ("03b-mesa-tablet.png", "Mesa en tablet", "La misma mesa en una tablet horizontal."),
    ("03c-mesa-cierre.png", "Cierre de combate", "Confirmación del ganador."),
    ("03d-kata-banderas.png", "Kata por banderas", "Voto de cada juez."),
    ("15-kata-rondas.png", "Kata por puntuación", "Notas por juez y ranking."),
    ("04-resultados.png", "Resultados", "Podios con sello y medallero por dojo."),
    ("14-shadow.png", "Shadow Mode", "Comparación con el registro en papel."),
    ("17-auditoria.png", "Auditoría", "Cada cambio con su motivo."),
    ("05-historial.png", "Historial deportivo", "Medallas, grados y combates de un competidor."),
    ("16-dojo.png", "Dojo", "Resultados del dojo por torneo."),
    ("06-usuarios.png", "Usuarios", "Cuentas, activación y contraseñas."),
    ("08-tema-oscuro.png", "Tema oscuro", "La app en el tema «Yoru»."),
    ("09-celular.png", "Celular", "Vista en pantalla de celular."),
]


def steps_html() -> str:
    out = []
    for i, st in enumerate(STEPS, start=1):
        how = "".join(f"<li>{html.escape(h)}</li>" for h in st["how"])
        who = "".join(f'<span class="role {ROLE[w][0]}">{ROLE[w][1]}</span>' for w in st["who"])
        tip = f'<p class="tip"><b>Consejo.</b> {html.escape(st["tip"])}</p>' if st.get("tip") else ""
        out.append(
            f"""<article class="step">
  <div class="step-text">
    <div class="step-num"><b>{i}</b><span>{html.escape(st["tag"])}</span></div>
    <h3>{html.escape(st["title"])}</h3>
    <p class="desc">{html.escape(st["desc"])}</p>
    <ul class="how">{how}</ul>
    <div class="who">{who}</div>
    {tip}
  </div>
  <div>{frame(*st["shot"])}</div>
</article>"""
        )
    return "\n".join(out)


def gallery_html() -> str:
    return "\n".join(
        f'<figure>{frame(f, t, bar=False)}<figcaption><b>{html.escape(t)}</b>{html.escape(d)}</figcaption></figure>'
        for f, t, d in GALLERY
        if (SHOTS / f).exists()
    )


MESA = json.loads((HERE / "pins.json").read_text())


def mesa_views() -> str:
    views = {}
    for key, v in MESA.items():
        views[key] = {"src": img(v["file"]), "alt": v["alt"], "pins": v["pins"]}
    return json.dumps(views, ensure_ascii=False)


def main() -> None:
    t = (HERE / "guia.template.html").read_text()
    t = t.replace("{{ENSO_MONO}}", ENSO_MONO).replace("{{ENSO}}", ENSO).replace("{{WORD}}", WORD).replace("{{STEPS}}", steps_html()).replace("{{GALLERY}}", gallery_html())
    t = t.replace("{{MESA_VIEWS}}", mesa_views())
    t = re.sub(r"\{\{IMG:([^}]+)\}\}", lambda m: img(m.group(1)), t)
    missing = [f for f, *_ in GALLERY if not (SHOTS / f).exists()]
    out = HERE / "guia-hajime.html"
    out.write_text(t)
    print(f"{out} {out.stat().st_size / 1e6:.2f} MB; faltan: {missing}")


if __name__ == "__main__":
    main()
