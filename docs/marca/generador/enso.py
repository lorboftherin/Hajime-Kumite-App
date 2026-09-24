"""Genera el ensō de Hajime (dos trazos: shu y sumi) como paths SVG en un viewBox 0 0 100 100.

Medidas tomadas de la referencia de marca: centro, radio de la línea media y
grosor del trazo en cada ángulo (grados, sentido horario desde las 3, con y
hacia abajo, como en pantalla). Ambos trazos giran en sentido antihorario.
"""

import math

SCALE = 100 / 440  # 440 px de la referencia = 100 unidades
CX = CY = 50.0


def interp(table, a):
    """Interpolación Catmull-Rom sobre (ángulo, valor) ordenados por ángulo."""
    xs = [t[0] for t in table]
    for i in range(len(xs) - 1):
        if xs[i] <= a <= xs[i + 1]:
            p0 = table[max(i - 1, 0)][1]
            p1, p2 = table[i][1], table[i + 1][1]
            p3 = table[min(i + 2, len(xs) - 1)][1]
            t = (a - xs[i]) / (xs[i + 1] - xs[i])
            return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
    return table[0][1] if a < xs[0] else table[-1][1]


def pt(a_deg, r):
    a = math.radians(a_deg)
    return CX + r * SCALE * math.cos(a), CY + r * SCALE * math.sin(a)


def fmt(p):
    return f"{p[0]:.2f} {p[1]:.2f}"


def body(a_start, a_end, center, width, steps=90, cap_start=True, end_style="round"):
    """Contorno de un trazo que va de a_start a a_end (grados, decreciente = antihorario)."""
    angs = [a_start + (a_end - a_start) * i / steps for i in range(steps + 1)]
    outer = [pt(a, interp(center, a) + interp(width, a) / 2) for a in angs]
    inner = [pt(a, interp(center, a) - interp(width, a) / 2) for a in angs]
    d = ["M" + fmt(outer[0])]
    d += ["L" + fmt(p) for p in outer[1:]]
    w_end = interp(width, a_end) / 2 * SCALE
    if end_style == "round":
        d.append(f"A{w_end:.2f} {w_end:.2f} 0 0 1 {fmt(inner[-1])}")
    else:
        d.append("L" + fmt(inner[-1]))
    d += ["L" + fmt(p) for p in reversed(inner[:-1])]
    w0 = interp(width, a_start) / 2 * SCALE
    d.append(f"A{w0:.2f} {w0:.2f} 0 0 0 {fmt(outer[0])}Z" if cap_start else "Z")
    return "".join(d)


# --- Trazo shu (rojo): arranca arriba (≈258°) y baja por la izquierda hasta ≈114° ---
RED_CENTER = [(102, 175), (114, 175), (120, 175), (135, 174.5), (150, 174.5), (180, 175), (210, 174.5), (225, 175), (240, 174.5), (255, 175.5), (258, 175.5)]
RED_WIDTH = [(102, 34), (114, 36), (120, 40), (135, 53), (150, 63), (180, 64), (210, 65), (225, 68), (240, 73), (255, 77), (258, 77)]

# --- Trazo sumi (negro): arranca abajo (≈100°), sube por la derecha y termina seco arriba ---
# Ángulos negativos = pasado de las 3 hacia arriba.
BLK_CENTER = [(-56, 178), (-45, 178.5), (-30, 179), (-15, 179), (0, 178), (15, 178.5), (30, 177), (45, 176), (60, 175), (75, 175), (90, 174.5), (100, 174)]
BLK_WIDTH = [(-56, 20), (-45, 35), (-30, 40), (-15, 48), (0, 56), (15, 61), (30, 64), (45, 64), (60, 66), (75, 68), (90, 71), (100, 72)]


def bristle(a0, a1, r0, r1, w0):
    """Hebra seca: filamento que se afina hasta una punta."""
    n = 24
    pts_o, pts_i = [], []
    for i in range(n + 1):
        t = i / n
        a = a0 + (a1 - a0) * t
        r = r0 + (r1 - r0) * t
        w = w0 * (1 - t) ** 1.3
        pts_o.append(pt(a, r + w / 2))
        pts_i.append(pt(a, r - w / 2))
    return "M" + fmt(pts_o[0]) + "".join("L" + fmt(p) for p in pts_o[1:]) + "".join("L" + fmt(p) for p in reversed(pts_i)) + "Z"


def red_path():
    return body(258, 102, RED_CENTER, RED_WIDTH, cap_start=True, end_style="taper")


def black_path():
    main = body(100, -56, BLK_CENTER, BLK_WIDTH, cap_start=True, end_style="flat")
    # Cola seca: cuatro hebras de distinto largo que salen del final del trazo.
    hairs = [
        bristle(-54, -66.5, 169.5, 173.0, 6.0),
        bristle(-54, -69.0, 175.5, 176.5, 7.0),
        bristle(-54, -67.5, 182.0, 181.0, 6.5),
        bristle(-54, -63.0, 187.5, 186.5, 5.0),
    ]
    return main + "".join(hairs)


SHU = "#BE3B2C"
AI = "#24477A"


def svg(red=SHU, black=AI, size=None, bg=None):
    attrs = f' width="{size}" height="{size}"' if size else ""
    rect = f'<rect width="100" height="100" fill="{bg}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"{attrs}>{rect}'
        f'<path fill="{red}" d="{red_path()}"/><path fill="{black}" d="{black_path()}"/></svg>'
    )


if __name__ == "__main__":
    import sys

    out = sys.argv[1] if len(sys.argv) > 1 else "enso.svg"
    open(out, "w").write(svg())
    print(out, len(red_path()) + len(black_path()), "chars")
