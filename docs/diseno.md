# Diseño visual: «Dō» (道, el camino)

La interfaz debe transmitir lo que el karate enseña fuera del combate:
**calma, respeto, disciplina y claridad**. No es decoración japonesa
superpuesta: son principios de la estética japonesa aplicados a una
herramienta que se usa bajo presión, en un coliseo ruidoso.

## 1. Principios

| Principio | Qué significa | Cómo se aplica en la app |
| --- | --- | --- |
| **Ma** (間), el espacio con intención | El vacío tiene tanto peso como lo que se muestra | Márgenes generosos, pocas líneas, agrupar por espacio y no por cajas. Una sola acción principal por pantalla |
| **Kanso** (簡素), simplicidad | Quitar todo lo que no ayuda | Sin sombras pesadas ni degradados. Las acciones raras se esconden en menús («revelar de a poco») |
| **Shibui** (渋い), belleza sobria | Elegancia discreta que no cansa | Paleta de pigmentos tradicionales apagados; un solo color de acento a la vez |
| **Wabi-sabi** (侘寂), imperfección honesta | Lo hecho a mano, lo vivo | El ensō del logo es un trazo abierto e irregular; textura sutil de papel washi; estados vacíos humanos |
| **Zanshin** (残心), atención que permanece | La mente alerta después de la técnica | Confirmaciones claras y serenas; el último evento siempre visible; deshacer siempre a mano |
| **Rei** (礼), respeto | Cortesía con quien usa la herramienta | Mensajes que explican y no culpan; nada destructivo sin confirmación |

Para la mesa de kumite manda otro principio, el del marcador deportivo:
**cada dato en un lugar fijo, legible en un vistazo de menos de 3 s, y solo
cambia lo que cambia**. Ahí la estética cede ante la legibilidad.

## 2. Color: pigmentos tradicionales

El karate ya tiene su dualidad cromática: **aka** (rojo) y **ao** (azul).
Los tomamos de los pigmentos clásicos del grabado japonés: **shu** (朱,
bermellón de los torii) y **ai** (藍, índigo).

### Claro: «Washi» (papel)

| Token | Nombre | Hex | Uso |
| --- | --- | --- | --- |
| `--washi` | Washi, papel | `#F5F0E6` | Fondo de la aplicación |
| `--kinu` | Kinu, seda | `#FBF8F2` | Superficies (tarjetas, tablas) |
| `--sumi` | Sumi, tinta | `#1E1C1A` | Texto principal |
| `--sumi-2` | Usuzumi, tinta diluida | `#4A463F` | Texto secundario |
| `--nezumi` | Nezumi, gris ratón | `#8A8377` | Texto tenue, iconos |
| `--kasumi` | Kasumi, bruma | `#E3DBCB` | Líneas y bordes |
| `--shu` | Shu, bermellón | `#B8322A` | **Aka** y acento principal (uso escaso) |
| `--shu-soft` | | `#F4DED8` | Fondos de aka |
| `--ai` | Ai, índigo | `#24477A` | **Ao** y enlaces |
| `--ai-soft` | | `#DCE4EF` | Fondos de ao |
| `--matcha` | Matcha | `#5E7A3A` | Éxito, en curso |
| `--yamabuki` | Yamabuki, dorado | `#B8862B` | Advertencias |
| `--kin` / `--gin` / `--dou` | Oro / plata / bronce | `#C9A24B` / `#A3A6A8` / `#9C6238` | Medallas |

### Oscuro: «Yoru» (noche en el dojo)

Fondo `#141311`, superficies `#1D1B19`, texto `#EDE7DA`, líneas `#34302B`.
Shu y ai suben de luminosidad (`#D9534A`, `#5A83C0`) para mantener el
contraste. La mesa de kumite tiene su propio tema de alto contraste, siempre
oscuro: rinde mejor bajo las luces del coliseo y no deslumbra.

Todos los pares texto/fondo cumplen WCAG AA (contraste de 4,5:1 o más).

## 3. Tipografía

Fuentes **incluidas en la app, no cargadas desde internet**: en el coliseo
puede no haber conexión.

- **Títulos:** *Shippori Mincho B1*. Serif de tradición japonesa con
  terminaciones de pincel; se usa poco y en tamaños grandes.
- **Interfaz y texto:** *Zen Kaku Gothic New*. Sans humanista japonesa,
  clara en tamaños pequeños y con cifras legibles.
- **Marcador y reloj:** *Zen Kaku Gothic New* en peso 900 con cifras
  tabulares, para que el reloj no «baile».

Escala: 12 / 14 / 16 / 20 / 28 / 40 px en la interfaz; en la mesa, el
marcador ocupa hasta un 40 % del alto de su panel.

## 4. Símbolos y texturas

- **Logo: ensō** (円相). Círculo de un solo trazo de pincel, abierto e
  imperfecto, junto a la palabra *Hajime* en Mincho.
- **Kanji como ornamento, nunca como único rótulo.** Cada sección lleva un
  kanji pequeño y tenue junto al nombre en español: 大会 Torneos,
  人 Personas, 道場 Dojos, 型 Plantillas, 表 Llave.
- **Hanko** (判子, sello rojo): los puestos del podio se muestran como sellos
  cuadrados de tinta shu con el número del puesto.
- **Washi:** textura de fibras casi invisible (2–3 % de opacidad) en el fondo.
- **Seigaiha** (olas): solo en la pantalla de inicio de sesión, muy tenue.

## 5. Movimiento

Lento y sereno: 180–320 ms con curva `cubic-bezier(.2,.7,.2,1)`. Nada
rebota. Al registrar un punto, una **gota de tinta** se expande desde el
botón y la cifra del marcador se asienta como un sello. Se respeta
`prefers-reduced-motion`: sin animaciones para quien lo pida.

## 6. Componentes

- **Botones:** primario en sumi sólido (no rojo: el rojo es de aka);
  secundario con borde fino; peligro en shu solo cuando se destruye algo.
- **Tarjetas:** borde de 1 px color kasumi, radio de 12 px, sin sombra;
  sombra suave solo al pasar el cursor sobre algo que se puede tocar.
- **Estados:** etiqueta con punto de color y texto (nunca solo color).
- **Estados vacíos:** ensō tenue más una frase breve y la acción siguiente.
- **Navegación:** barra lateral con kanji y etiqueta, que se pliega a solo
  kanji en pantallas medianas; en celular, barra inferior.

## 7. Mesa de kumite

La pantalla más importante:

- **Posiciones fijas:** aka a la izquierda, reloj al centro, ao a la
  derecha, historial abajo. Nada se mueve de lugar durante el combate.
- **Jerarquía:** marcador (enorme) → reloj → sanciones → botones de punto
  → acciones raras. Kiken, shikkaku y walkover van en un menú «Más», no a
  la vista.
- **Toque:** botones de al menos 64 px de alto en tablet, separados para
  evitar toques accidentales. Deshacer siempre visible.
- **Estado del reloj:** detenido = cifras en washi con la palabra «YAME»;
  corriendo = cifras en matcha claro con un pulso lento del borde.
- **Senshu:** pequeño disco dorado con 先 junto al marcador.
- **Sanciones:** escalera de 5 marcas que se llenan en tinta.

## Fuentes consultadas

- [Ma (negative space), Wikipedia](https://en.wikipedia.org/wiki/Ma_(negative_space))
- [Wabi-sabi, Wikipedia](https://en.wikipedia.org/wiki/Wabi-sabi)
- [Japanese Design Philosophy: Ma, Wabi-Sabi, Mono no Aware](http://kadirkara.com.tr/blog/japanese-design-philosophy-ma-wabi-sabi-mono-no-aware)
- [Traditional colors of Japan, Wikipedia](https://en.wikipedia.org/wiki/Traditional_colors_of_Japan)
- [Japanese Traditional Colors guide, ColorFYI](https://colorfyi.com/blog/japanese-traditional-colors/)
- [The Enso Circle in Modern Design](https://theartofzen.org/the-enso-circle-in-modern-design-influences-and-inspirations/)
- [Scoreboard design principles, TrackScore](https://trackscore.online/blog/scoreboard-design-principles)
- [El marcador de béisbol como diseño de UI (note.com)](https://note.com/amotdesign/n/n5b8f495a7321?hl=en)
- [Dashboard design principles 2026, UXPin](https://www.uxpin.com/studio/blog/dashboard-design-principles/)
- [Dashboard UX patterns, Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards)
