// Idioma de la interfaz (docs/idiomas.md). Un solo build: el texto fuente está en
// español (es-PE) y las traducciones se cargan en tiempo de ejecución, ANTES de
// arrancar Angular (main.ts). Este archivo no depende de Angular para poder
// usarse antes del arranque.
import { registerLocaleData } from '@angular/common';
import { loadTranslations } from '@angular/localize';

export type CodigoIdioma = 'es' | 'en' | 'pt-BR';

export interface Idioma {
  codigo: CodigoIdioma;
  /** Locale de Angular e Intl: fechas, números y reglas de plural. */
  locale: string;
  /** Nombre en su propio idioma (no se traduce: así lo reconoce quien lo habla). */
  nombre: string;
}

export const IDIOMAS: readonly Idioma[] = [
  { codigo: 'es', locale: 'es-PE', nombre: 'Español' },
  { codigo: 'en', locale: 'en-US', nombre: 'English' },
  { codigo: 'pt-BR', locale: 'pt-BR', nombre: 'Português (Brasil)' },
];

export const IDIOMA_FUENTE: Idioma = IDIOMAS[0];

/** Clave en localStorage con la preferencia del dispositivo. */
export const CLAVE_IDIOMA = 'hajime.idioma';

let actual: Idioma = IDIOMA_FUENTE;

/** Idioma con el que arrancó la app (cambiarlo exige recargar). */
export function idiomaActual(): Idioma {
  return actual;
}

/** Locale activo para Intl (fechas, números, listas). */
export function localeActual(): string {
  return actual.locale;
}

export function buscarIdioma(codigo: string | null | undefined): Idioma | undefined {
  return IDIOMAS.find((i) => i.codigo === codigo);
}

/** Preferencia guardada en el dispositivo; null si no hay o el almacenamiento falla. */
export function idiomaGuardado(almacen: Pick<Storage, 'getItem'> | null = almacenLocal()): CodigoIdioma | null {
  try {
    const v = almacen?.getItem(CLAVE_IDIOMA);
    return buscarIdioma(v)?.codigo ?? null;
  } catch {
    return null;
  }
}

/** Guarda la preferencia; devuelve false si el navegador no deja guardar (modo privado). */
export function guardarIdioma(
  codigo: CodigoIdioma,
  almacen: Pick<Storage, 'setItem'> | null = almacenLocal(),
): boolean {
  try {
    almacen?.setItem(CLAVE_IDIOMA, codigo);
    return !!almacen;
  } catch {
    return false;
  }
}

/**
 * Preferencia guardada > idiomas del navegador (navigator.languages) > español.
 * «pt», «pt-PT» y «pt-BR» usan pt-BR; «en-GB» usa en; cualquier «es-*» usa es.
 */
export function elegirIdioma(guardado: string | null, navegador: readonly string[]): CodigoIdioma {
  const g = buscarIdioma(guardado);
  if (g) return g.codigo;
  for (const tag of navegador) {
    const base = (tag || '').toLowerCase().split('-')[0];
    if (base === 'es') return 'es';
    if (base === 'en') return 'en';
    if (base === 'pt') return 'pt-BR';
  }
  return IDIOMA_FUENTE.codigo;
}

/** Datos de Angular (fechas, plurales de ICU) de cada locale; es-PE viene en el build. */
const DATOS_LOCALE: Partial<Record<CodigoIdioma, () => Promise<{ default: unknown }>>> = {
  'pt-BR': () => import('@angular/common/locales/pt'),
  // en-US ya viene incluido en @angular/core.
};

interface ArchivoTraducciones {
  locale?: string;
  translations: Record<string, string>;
}

export interface OpcionesCarga {
  fetch?: typeof fetch;
  navegador?: readonly string[];
  guardado?: string | null;
}

/**
 * Elige el idioma y carga sus traducciones antes del arranque. Nunca falla: si
 * el archivo no existe, no es JSON o la red falla, la app sigue en español.
 */
export async function cargarIdioma(opciones: OpcionesCarga = {}): Promise<Idioma> {
  const guardado = opciones.guardado !== undefined ? opciones.guardado : idiomaGuardado();
  const navegador = opciones.navegador ?? idiomasNavegador();
  const idioma = buscarIdioma(elegirIdioma(guardado, navegador)) ?? IDIOMA_FUENTE;
  actual = IDIOMA_FUENTE;
  if (idioma.codigo !== IDIOMA_FUENTE.codigo) {
    try {
      const f = opciones.fetch ?? globalThis.fetch.bind(globalThis);
      const [res, datos] = await Promise.all([
        // Relativa a <base href>: sirve igual en el servidor y en la app Android.
        f(`i18n/${idioma.codigo}.json`, { cache: 'no-cache' }),
        DATOS_LOCALE[idioma.codigo]?.(),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const archivo = (await res.json()) as ArchivoTraducciones;
      if (!archivo || typeof archivo.translations !== 'object' || archivo.translations === null) {
        throw new Error('formato inválido');
      }
      if (datos) registerLocaleData(datos.default, idioma.locale);
      loadTranslations(archivo.translations);
      actual = idioma;
    } catch (e) {
      console.warn(`No se pudo cargar el idioma ${idioma.codigo}; se usa español.`, e);
    }
  }
  const g = globalThis as { $localize?: { locale?: string } };
  if (g.$localize) g.$localize.locale = actual.locale;
  if (typeof document !== 'undefined') document.documentElement.lang = actual.locale;
  return actual;
}

/** Cambia el idioma del dispositivo y recarga la app (las traducciones se cargan al arrancar). */
export function cambiarIdioma(codigo: CodigoIdioma, recargar: () => void = () => location.reload()): void {
  if (codigo === actual.codigo && idiomaGuardado() === codigo) return;
  guardarIdioma(codigo);
  recargar();
}

function almacenLocal(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function idiomasNavegador(): readonly string[] {
  const n = globalThis.navigator;
  if (!n) return [];
  return n.languages?.length ? n.languages : n.language ? [n.language] : [];
}
