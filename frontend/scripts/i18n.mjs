#!/usr/bin/env node
// Traducciones de la interfaz (docs/idiomas.md).
//
//   node scripts/i18n.mjs resumen [--podar]
//       Tras `ng extract-i18n`: cuántos textos faltan o sobran en cada idioma.
//       Con --podar quita de en.json y pt-BR.json los IDs que ya no existen.
//   node scripts/i18n.mjs revisar [--sin-extraer]
//       Para CI: vuelve a extraer en una carpeta temporal y falla si
//       src/locale/messages.json no está al día, si a un idioma le falta un ID,
//       le sobra uno, tiene una traducción vacía o no respeta los marcadores
//       ({$INTERPOLATION}, {$START_TAG_STRONG}, ICU…).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALE = join(RAIZ, 'src', 'locale');
const FUENTE = join(LOCALE, 'messages.json');
/** Idiomas traducidos (el español es la fuente). Agregar uno: docs/idiomas.md. */
const IDIOMAS = ['en', 'pt-BR'];

const leer = (ruta) => JSON.parse(readFileSync(ruta, 'utf8'));
const archivoIdioma = (codigo) => join(LOCALE, `${codigo}.json`);

/** Marcadores de un mensaje: {$X} y variables de ICU ({VAR_PLURAL, plural, …}). */
function marcadores(texto) {
  const ph = [...texto.matchAll(/\{\$([^}]+)\}/g)].map((m) => m[1]);
  const icu = [...texto.matchAll(/\{(VAR_[A-Z0-9_]+)\s*,/g)].map((m) => m[1]);
  return [...ph, ...icu].sort().join(' ');
}

function comparar(fuente, codigo) {
  const ruta = archivoIdioma(codigo);
  let t;
  try {
    t = leer(ruta).translations ?? {};
  } catch (e) {
    return {
      faltan: Object.keys(fuente),
      sobran: [],
      vacias: [],
      marcas: [],
      iguales: 0,
      error: String(e),
    };
  }
  const faltan = Object.keys(fuente).filter((id) => !(id in t));
  const sobran = Object.keys(t).filter((id) => !(id in fuente));
  const vacias = Object.keys(t).filter((id) => id in fuente && !String(t[id]).trim());
  const marcas = Object.keys(t).filter(
    (id) => id in fuente && String(t[id]).trim() && marcadores(fuente[id]) !== marcadores(t[id]),
  );
  const iguales = Object.keys(t).filter((id) => fuente[id] === t[id]).length;
  return { faltan, sobran, vacias, marcas, iguales };
}

function lista(titulo, ids, max = 20) {
  if (!ids.length) return;
  console.log(`  ${titulo} (${ids.length}):`);
  for (const id of ids.slice(0, max)) console.log(`    - ${id}`);
  if (ids.length > max) console.log(`    … y ${ids.length - max} más`);
}

function resumen(podar) {
  const fuente = leer(FUENTE).translations;
  console.log(`Fuente (es-PE): ${Object.keys(fuente).length} textos en src/locale/messages.json`);
  for (const codigo of IDIOMAS) {
    const r = comparar(fuente, codigo);
    console.log(
      `\n${codigo}: faltan ${r.faltan.length}, sobran ${r.sobran.length}, iguales al español ${r.iguales}`,
    );
    lista('Faltan', r.faltan);
    lista('Sobran (IDs que ya no existen)', r.sobran);
    lista('Marcadores distintos del original', r.marcas);
    if (podar && r.sobran.length) {
      const archivo = leer(archivoIdioma(codigo));
      for (const id of r.sobran) delete archivo.translations[id];
      escribir(codigo, archivo);
      console.log(`  → se quitaron ${r.sobran.length} IDs obsoletos de ${codigo}.json`);
    }
  }
}

function escribir(codigo, archivo) {
  const ordenado = Object.fromEntries(
    Object.entries(archivo.translations).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    archivoIdioma(codigo),
    JSON.stringify({ locale: archivo.locale ?? codigo, translations: ordenado }, null, 2) + '\n',
  );
}

function revisar(extraer) {
  let errores = 0;
  const fuente = leer(FUENTE).translations;
  if (extraer) {
    const tmp = mkdtempSync(join(tmpdir(), 'hajime-i18n-'));
    try {
      execFileSync('npx', ['ng', 'extract-i18n', '--output-path', tmp], {
        cwd: RAIZ,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const nueva = leer(join(tmp, 'messages.json')).translations;
      const cambios = [
        ...Object.keys(nueva).filter((id) => fuente[id] !== nueva[id]),
        ...Object.keys(fuente).filter((id) => !(id in nueva)),
      ];
      if (cambios.length) {
        errores++;
        console.log(
          'src/locale/messages.json no está al día con el código: corre `npm run i18n:extract`.',
        );
        lista('IDs nuevos, cambiados o borrados', cambios);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  for (const codigo of IDIOMAS) {
    const r = comparar(fuente, codigo);
    if (r.error) console.log(`${codigo}: no se pudo leer ${codigo}.json (${r.error})`);
    const mal = r.faltan.length + r.sobran.length + r.vacias.length + r.marcas.length;
    if (mal) {
      errores++;
      console.log(`\n${codigo}: ${mal} problemas`);
      lista('Sin traducir', r.faltan);
      lista('Sobran (corre `node scripts/i18n.mjs resumen --podar`)', r.sobran);
      lista('Traducción vacía', r.vacias);
      lista('Marcadores distintos del original', r.marcas);
    } else {
      console.log(`${codigo}: ${Object.keys(fuente).length} textos traducidos ✓`);
    }
  }
  if (errores) {
    console.log(
      '\nFaltan traducciones o no coinciden con los textos en español (docs/idiomas.md).',
    );
    process.exit(1);
  }
}

const [orden, ...args] = process.argv.slice(2);
if (orden === 'resumen') resumen(args.includes('--podar'));
else if (orden === 'revisar') revisar(!args.includes('--sin-extraer'));
else {
  console.error('Uso: node scripts/i18n.mjs resumen [--podar] | revisar [--sin-extraer]');
  process.exit(2);
}
