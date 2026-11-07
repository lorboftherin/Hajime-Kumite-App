// Convierte un documento Markdown de docs/ en un PDF con la marca Hajime.
//   cd scripts/docs-pdf && npm ci && node generar.mjs <entrada.md> <salida.pdf> "<Título>" "<Subtítulo>"
// Usa el Chromium de Playwright del frontend (cd frontend && npm ci). Ver README.md.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Marked } from 'marked';
import { gfmHeadingId, getHeadingList } from 'marked-gfm-heading-id';

const [, , entrada, salida, titulo, subtitulo] = process.argv;
const REPO = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const AQUI = dirname(new URL(import.meta.url).pathname);
const require = createRequire(`${REPO}/frontend/package.json`);
const { chromium } = require('@playwright/test');

const mdDir = dirname(resolve(entrada));
let md = readFileSync(entrada, 'utf8');
// El título del documento va en la portada; el índice lo generamos nosotros.
md = md.replace(/^# .*\n/, '');
md = md.replace(/\n## (Contenido|Índice|Tabla de contenido|Tabla de contenidos)\n[\s\S]*?(?=\n## )/i, '\n');
// Anclajes sueltos antes de un título (<a id="x"></a>): se mueven dentro del título para
// que no ocupen una línea al pie de página y empujen el capítulo a una hoja en blanco.
md = md.replace(/^<a id="([^"]+)"><\/a>\s*\n(?:\s*\n)*(#{1,6} .*)$/gm, (_, id, h) => `${h} <span id="${id}"></span>`);
md = md.replace(/^---\s*$/gm, '');

const marked = new Marked({ gfm: true });
marked.use(gfmHeadingId());
marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang === 'mermaid') return `<div class="diagrama"><pre class="mermaid">${esc(text)}</pre></div>`;
      return `<pre class="codigo"><code>${esc(text)}</code></pre>`;
    },
    image({ href, title, text }) {
      let src = href;
      if (!/^(https?:|data:|file:)/.test(href)) {
        const abs = resolve(mdDir, decodeURI(href));
        src = existsSync(abs) ? pathToFileURL(abs).href : href;
      }
      const pie = text ? `<figcaption>${esc(text)}</figcaption>` : '';
      return `<figure><img src="${src}" alt="${esc(text || '')}"${title ? ` title="${esc(title)}"` : ''}>${pie}</figure>`;
    },
    link({ href, text }) {
      // Enlaces a otros .md del repo no sirven dentro de un PDF: se dejan como texto.
      if (href && !/^(https?:|mailto:|#)/.test(href)) return `<span class="ref">${text}</span>`;
      return `<a href="${href}">${text}</a>`;
    },
  },
});
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const cuerpo = marked.parse(md);
const encabezados = getHeadingList().filter((h) => h.level === 2 || h.level === 3);
const indice = encabezados
  .map((h) => `<li class="n${h.level}"><a href="#${h.id}">${h.text.replace(/<span id="[^"]*"><\/span>/g, '')}</a></li>`)
  .join('\n');

const version = readFileSync(`${REPO}/VERSION`, 'utf8').trim();
const fecha = new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' });
const logo = pathToFileURL(`${REPO}/docs/marca/hajime-logo-horizontal.svg`).href;
const fuente = (pkg, archivo) => pathToFileURL(`${AQUI}/node_modules/@fontsource/${pkg}/files/${archivo}`).href;

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<style>
@font-face{font-family:'Zen Kaku';font-weight:400;src:url('${fuente('zen-kaku-gothic-new', 'zen-kaku-gothic-new-latin-400-normal.woff2')}')}
@font-face{font-family:'Zen Kaku';font-weight:700;src:url('${fuente('zen-kaku-gothic-new', 'zen-kaku-gothic-new-latin-700-normal.woff2')}')}
@font-face{font-family:'Cormorant';font-weight:500;src:url('${fuente('cormorant-garamond', 'cormorant-garamond-latin-500-normal.woff2')}')}
@font-face{font-family:'Cormorant';font-weight:600;src:url('${fuente('cormorant-garamond', 'cormorant-garamond-latin-600-normal.woff2')}')}
:root{--shu:#BE3B2C;--ai:#24477A;--sumi:#1B1B1B;--washi:#F3F0E8;--nezumi:#6E6860;--linea:#ddd6c8}
@page{size:A4;margin:22mm 18mm 20mm 18mm}
*{box-sizing:border-box}
html{font-family:'Zen Kaku',system-ui,sans-serif;font-size:10pt;color:var(--sumi);line-height:1.55}
body{margin:0}
.portada{height:246mm;display:flex;flex-direction:column;justify-content:space-between;page-break-after:always;padding:6mm 0}
.portada img{width:95mm}
.portada .banda{border-left:4px solid var(--shu);padding-left:8mm}
.portada h1{font-family:'Cormorant',serif;font-weight:600;font-size:40pt;line-height:1.05;margin:0 0 4mm;color:var(--sumi)}
.portada .sub{font-size:13pt;color:var(--nezumi);max-width:140mm}
.portada .meta{font-size:9.5pt;color:var(--nezumi);border-top:1px solid var(--linea);padding-top:4mm;display:flex;justify-content:space-between}
.indice{page-break-after:always}
.indice h2{margin-top:0}
.indice ol{list-style:none;padding:0;margin:0;columns:1}
.indice li{margin:1.2mm 0}
.indice li.n3{padding-left:7mm;font-size:9pt;color:var(--nezumi)}
.indice a{color:inherit;text-decoration:none}
h1,h2,h3,h4{font-family:'Cormorant',serif;font-weight:600;color:var(--sumi);line-height:1.2;page-break-after:avoid;break-after:avoid}
h2{font-size:22pt;margin:0 0 5mm;padding-bottom:2mm;border-bottom:2px solid var(--shu);page-break-before:always;break-before:page}
h3{font-size:15pt;margin:7mm 0 2.5mm;color:var(--ai)}
h4{font-size:12pt;margin:5mm 0 2mm}
p{margin:0 0 3mm}
ul,ol{margin:0 0 3mm;padding-left:6mm}
li{margin:0.8mm 0}
a{color:var(--ai)}
.ref{font-style:italic}
strong{font-weight:700}
code{font-family:'DejaVu Sans Mono',ui-monospace,monospace;font-size:8.6pt;background:#f1ece2;padding:0.2mm 1mm;border-radius:1mm}
pre.codigo{background:#f6f2ea;border:1px solid var(--linea);border-left:3px solid var(--ai);padding:3mm;border-radius:1.5mm;white-space:pre-wrap;word-break:break-word;font-size:8.3pt;page-break-inside:avoid}
pre.codigo code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:2mm 0 4mm;font-size:8.8pt;page-break-inside:auto}
thead{display:table-header-group}
tr{page-break-inside:avoid;break-inside:avoid}
th{background:var(--washi);text-align:left;font-weight:700;border-bottom:2px solid var(--sumi)}
th,td{padding:1.6mm 2mm;border-bottom:1px solid var(--linea);vertical-align:top}
blockquote{margin:3mm 0;padding:2.5mm 4mm;background:#fbf3ef;border-left:3px solid var(--shu);border-radius:1mm}
blockquote p:last-child{margin:0}
figure{margin:3mm 0 5mm;text-align:center;page-break-inside:avoid;break-inside:avoid}
figure img{max-width:100%;max-height:120mm;border:1px solid var(--linea);border-radius:1.5mm}
figcaption{font-size:8.5pt;color:var(--nezumi);margin-top:1.5mm}
.diagrama{margin:3mm 0 5mm;text-align:center;page-break-inside:avoid;break-inside:avoid}
.diagrama svg{width:100%!important;max-width:100%!important;height:auto!important;max-height:215mm}
hr{display:none}
a[id]:empty{display:block;height:0;margin:0;line-height:0}
p:has(> a[id]:empty:only-child){margin:0;height:0;line-height:0;overflow:hidden}
</style></head><body>
<section class="portada">
  <img src="${logo}" alt="Hajime">
  <div class="banda"><h1>${esc(titulo)}</h1><div class="sub">${esc(subtitulo)}</div></div>
  <div class="meta"><span>Hajime · Torneos de karate</span><span>Versión ${version} · ${fecha}</span></div>
</section>
<section class="indice"><h2 id="indice">Contenido</h2><ol>${indice}</ol></section>
<main>${cuerpo}</main>
<script src="${pathToFileURL(`${AQUI}/node_modules/mermaid/dist/mermaid.min.js`).href}"></script>
<script>
mermaid.initialize({startOnLoad:false,theme:'base',securityLevel:'loose',flowchart:{useMaxWidth:true},sequence:{useMaxWidth:true},er:{useMaxWidth:true},
  themeVariables:{fontFamily:'Zen Kaku, sans-serif',primaryColor:'#F3F0E8',primaryBorderColor:'#24477A',primaryTextColor:'#1B1B1B',lineColor:'#6E6860',secondaryColor:'#fbf3ef',tertiaryColor:'#eef2f8'}});
mermaid.run({querySelector:'pre.mermaid'}).then(()=>{document.body.dataset.listo='1'},e=>{document.body.dataset.listo='error';document.body.dataset.error=String(e)});
</script>
</body></html>`;

const navegador = await chromium.launch({
  executablePath: process.env.HAJIME_E2E_CHROMIUM || undefined,
});
const pagina = await navegador.newPage();
const errores = [];
pagina.on('pageerror', (e) => errores.push(String(e)));
const htmlPath = salida.replace(/\.pdf$/, '.tmp.html');
writeFileSync(htmlPath, html);
await pagina.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
await pagina.waitForFunction(() => document.body.dataset.listo, null, { timeout: 60000 });
const estado = await pagina.evaluate(() => [document.body.dataset.listo, document.body.dataset.error || '']);
const rotas = await pagina.evaluate(() => [...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.getAttribute('src')));
await pagina.pdf({
  path: salida,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  margin: { top: '22mm', bottom: '20mm', left: '18mm', right: '18mm' },
  headerTemplate: `<div style="width:100%;font-size:7.5pt;color:#6E6860;padding:0 18mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>Hajime</span><span>${esc(titulo)}</span></div>`,
  footerTemplate: `<div style="width:100%;font-size:7.5pt;color:#6E6860;padding:0 18mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>Versión ${version}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
});
await navegador.close();
(await import('node:fs')).rmSync(htmlPath, { force: true });
console.log(JSON.stringify({ salida, mermaid: estado, imagenesRotas: rotas, errores, secciones: encabezados.length }));
