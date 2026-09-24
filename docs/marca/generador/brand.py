"""Genera los archivos de marca de Hajime (SVG con texto convertido a trazos).

Medidas del logotipo horizontal tomadas de la referencia de marca (lienzo de
2000 × 1143 px). Tipografías: Cormorant Garamond 500 («Hajime»), Zen Kaku
Gothic New 400 (eslogan) y Shippori Mincho B1 (kanji).
"""

import json
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

import enso

HERE = Path(__file__).parent
FONTS = HERE / "fonts"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out"
OUT.mkdir(parents=True, exist_ok=True)

F_CORM = FONTS / "fontsource-cormorant-garamond-5.3.0/package/files/cormorant-garamond-latin-500-normal.woff2"
F_ZEN = FONTS / "fontsource-zen-kaku-gothic-new-5.3.0/package/files/zen-kaku-gothic-new-latin-400-normal.woff2"
F_MIN5 = FONTS / "fontsource-shippori-mincho-b1-5.3.0/package/files/shippori-mincho-b1-japanese-500-normal.woff2"
F_MIN8 = FONTS / "fontsource-shippori-mincho-b1-5.3.0/package/files/shippori-mincho-b1-japanese-800-normal.woff2"

# Colores de la marca (referencia)
SHU = "#BE3B2C"
SUMI = "#1B1B1B"
WASHI = "#F3F0E8"
KINU = "#FAF8F3"
NEZUMI = "#6E6860"
KASUMI = "#DDD6C8"
KANJI = "#8F897E"
YORU = "#1D1E22"
AI = "#24477A"  # ao: el mismo índigo que usa la app para AO
AI_YORU = "#4A77B8"  # índigo aclarado para que el trazo ao se lea sobre fondo oscuro
WASHI_TEXT = "#F3F0E8"
YORU_SUB = "#B3AC9F"

_fonts: dict[str, tuple] = {}


def font(path: Path):
    key = str(path)
    if key not in _fonts:
        tt = TTFont(path)
        data = path.read_bytes()
        face = hb.Face(hb.Blob(data)) if False else None  # noqa: F841 (harfbuzz lee woff2 vía fontTools)
        # harfbuzz no abre woff2 directo: se convierte a sfnt en memoria.
        import io

        buf = io.BytesIO()
        tt.flavor = None
        tt.save(buf)
        hbf = hb.Font(hb.Face(buf.getvalue()))
        _fonts[key] = (TTFont(path), hbf)
    return _fonts[key]


def shape(path: Path, text: str, size: float, tracking: float = 0.0):
    """Devuelve [(glyph_name, x, y)] en unidades de la fuente escaladas a `size`, y el avance total."""
    tt, hbf = font(path)
    upm = tt["head"].unitsPerEm
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbf, buf, {"kern": True, "liga": False})
    order = tt.getGlyphOrder()
    s = size / upm
    x = 0.0
    out = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions, strict=True):
        out.append((order[info.codepoint], x + pos.x_offset * s, pos.y_offset * s))
        x += pos.x_advance * s + tracking * size
    return out, x - tracking * size, s


def ink_box(path: Path, glyphs, s):
    tt, _ = font(path)
    gs = tt.getGlyphSet()
    from fontTools.pens.boundsPen import BoundsPen

    xs0, xs1, ys0, ys1 = [], [], [], []
    for name, x, y in glyphs:
        bp = BoundsPen(gs)
        gs[name].draw(bp)
        if bp.bounds:
            b0, c0, b1, c1 = bp.bounds
            xs0.append(x + b0 * s)
            xs1.append(x + b1 * s)
            ys0.append(y + c0 * s)
            ys1.append(y + c1 * s)
    return min(xs0), max(xs1), min(ys0), max(ys1)


def text_path(path: Path, text: str, size: float, *, left: float | None = None, center: float | None = None,
              baseline: float, tracking: float = 0.0, width: float | None = None) -> str:
    """Path SVG del texto. `left`/`center` refieren a la tinta visible. `width` ajusta el tracking para ocupar ese ancho."""
    glyphs, adv, s = shape(path, text, size, tracking)
    x0, x1, _, _ = ink_box(path, glyphs, s)
    if width is not None and len(text) > 1:
        extra = (width - (x1 - x0)) / (len(text) - 1)
        glyphs, adv, s = shape(path, text, size, tracking + extra / size)
        x0, x1, _, _ = ink_box(path, glyphs, s)
    dx = (left - x0) if left is not None else (center - (x0 + x1) / 2)
    tt, _ = font(path)
    gs = tt.getGlyphSet()
    pen = SVGPathPen(gs)
    for name, x, y in glyphs:
        tp = TransformPen(pen, (s, 0, 0, -s, dx + x, baseline - y))
        gs[name].draw(tp)
    return pen.getCommands()


def glyph_box(path: Path, text: str, size: float):
    glyphs, adv, s = shape(path, text, size)
    return ink_box(path, glyphs, s)


def enso_group(x: float, y: float, size: float, red: str, black: str) -> str:
    k = size / 100
    return (
        f'<g transform="translate({x:.2f} {y:.2f}) scale({k:.5f})">'
        f'<path fill="{red}" d="{enso.red_path()}"/><path fill="{black}" d="{enso.black_path()}"/></g>'
    )


def hanko(x: float, y: float, size: float, color: str = SHU) -> str:
    """Sello cuadrado con 始 en blanco."""
    r = size * 0.09
    x0, x1, y0, y1 = glyph_box(F_MIN8, "始", size * 0.72)
    base = y + size / 2 + (y1 + y0) / 2
    d = text_path(F_MIN8, "始", size * 0.72, center=x + size / 2, baseline=base)
    return f'<rect x="{x:.2f}" y="{y:.2f}" width="{size:.2f}" height="{size:.2f}" rx="{r:.2f}" fill="{color}"/><path fill="#FFFFFF" d="{d}"/>'


def svg(view: tuple[float, float, float, float], body: str, bg: str | None = None, title: str = "Hajime") -> str:
    x, y, w, h = view
    rect = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x:.1f} {y:.1f} {w:.1f} {h:.1f}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{rect}{body}</svg>\n"
    )


# ---------------------------------------------------------------------------
# Logotipo horizontal (coordenadas de la referencia)
# ---------------------------------------------------------------------------

def horizontal(ink=SUMI, red=SHU, enso_black=AI, sub=NEZUMI, rule=NEZUMI, vline=KASUMI, kanji=KANJI, with_kanji=True):
    parts = [enso_group(290, 353.5, 440, red, enso_black)]
    cap = 625 / 1000
    parts.append(f'<path fill="{ink}" d="{text_path(F_CORM, "Hajime", 130 / cap, left=871, baseline=601, width=602)}"/>')
    parts.append(f'<rect x="878" y="685.8" width="63.5" height="1.6" fill="{rule}"/>')
    parts.append(
        f'<path fill="{sub}" d="{text_path(F_ZEN, "TORNEOS DE KARATE", 18 / 0.70, left=971, baseline=696.5, width=385)}"/>'
    )
    if with_kanji:
        parts.append(f'<rect x="1612.4" y="360" width="1.6" height="422" fill="{vline}"/>')
        parts.append(f'<path fill="{kanji}" d="{text_path(F_MIN5, "始", 40, center=1698.5, baseline=505)}"/>')
        parts.append(f'<path fill="{kanji}" d="{text_path(F_MIN5, "め", 40, center=1698.5, baseline=565)}"/>')
        parts.append(hanko(1676, 629, 44.5))
        view = (250, 318, 1540, 507)
    else:
        view = (250, 318, 1270, 507)
    return view, "".join(parts)


# ---------------------------------------------------------------------------
# Logotipo vertical
# ---------------------------------------------------------------------------

def vertical(ink=SUMI, red=SHU, enso_black=AI, sub=NEZUMI, seal=True):
    cx = 300
    parts = [enso_group(cx - 150, 40, 300, red, enso_black)]
    parts.append(f'<path fill="{ink}" d="{text_path(F_CORM, "Hajime", 150, center=cx, baseline=452, width=602 / 208 * 150)}"/>')
    parts.append(f'<path fill="{sub}" d="{text_path(F_ZEN, "TORNEOS DE KARATE", 22, center=cx, baseline=522, width=370)}"/>')
    h = 600
    if seal:
        parts.append(hanko(cx - 25, 560, 50))
        h = 650
    return (0, 0, 600, h), "".join(parts)


# ---------------------------------------------------------------------------
# Ícono de app y favicon
# ---------------------------------------------------------------------------

def app_icon(bg=WASHI, enso_black=AI, border=None):
    stroke = f' stroke="{border}" stroke-width="2"' if border else ""
    body = f'<rect x="1" y="1" width="254" height="254" rx="58" fill="{bg}"{stroke}/>' + enso_group(43, 43, 170, SHU, enso_black)
    return (0, 0, 256, 256), body


def favicon():
    return (0, 0, 100, 100), enso_group(0, 0, 100, SHU, AI)


def main():
    files = {}
    v, b = horizontal()
    files["hajime-logo-horizontal.svg"] = svg(v, b)
    v, b = horizontal(with_kanji=False)
    files["hajime-logo-horizontal-sin-kanji.svg"] = svg(v, b)
    v, b = horizontal(ink=WASHI_TEXT, enso_black=AI_YORU, sub=YORU_SUB, rule=YORU_SUB, vline="#3A3833", kanji="#8F897E")
    files["hajime-logo-oscuro.svg"] = svg(v, b, bg=YORU)
    v, b = horizontal(ink=SUMI, red=SUMI, enso_black=SUMI, sub=SUMI, rule=SUMI, with_kanji=False)
    files["hajime-logo-sumi.svg"] = svg(v, b)
    v, b = vertical()
    files["hajime-logo-vertical.svg"] = svg(v, b)
    v, b = app_icon()
    files["hajime-icono-app.svg"] = svg(v, b)
    v, b = app_icon(bg="#1D1E22", enso_black=AI_YORU)
    files["hajime-icono-app-oscuro.svg"] = svg(v, b)
    v, b = favicon()
    files["favicon.svg"] = svg(v, b)
    # Piezas para la app (sin fondo): ensō solo y palabra «Hajime» en trazos
    files["hajime-enso.svg"] = svg((0, 0, 100, 100), enso_group(0, 0, 100, SHU, AI), title="Ensō de Hajime")
    for name, content in files.items():
        (OUT / name).write_text(content)
    # Datos para el componente Angular: paths en el viewBox 0 0 100 100 y la palabra.
    word = text_path(F_CORM, "Hajime", 100, left=0, baseline=0, width=602 / 208 * 100)
    wx0, wx1, wy0, wy1 = glyph_box(F_CORM, "Hajime", 100)
    tag = text_path(F_ZEN, "TORNEOS DE KARATE", 12, left=0, baseline=0, width=190)
    (OUT / "logo-paths.json").write_text(
        json.dumps(
            {
                "enso_shu": enso.red_path(),
                "enso_sumi": enso.black_path(),
                "word": word,
                "word_box": [wx0, -wy1, wx1 - wx0, wy1 - wy0],
                "tagline": tag,
            }
        )
    )
    print("ok", sorted(files))


if __name__ == "__main__":
    main()
