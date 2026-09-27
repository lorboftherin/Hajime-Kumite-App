import { formatDate, formatNumber, getLocaleId } from '@angular/common';
import { clearTranslations } from '@angular/localize';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDate, fmtDateTime, fmtSoles } from '../format';
import { joinList } from '../../shared/plural';
import { etiquetas } from './etiquetas';
import {
  CLAVE_IDIOMA,
  cambiarIdioma,
  cargarIdioma,
  elegirIdioma,
  guardarIdioma,
  idiomaActual,
  idiomaGuardado,
  localeActual,
} from './idioma';

/** fetch falso que responde el JSON dado (o el error). */
function respuesta(cuerpo: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    typeof cuerpo === 'string'
      ? new Response(cuerpo, { status, headers: { 'Content-Type': 'text/html' } })
      : new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

const saludo = () => $localize`:@@prueba.saludo:Hola ${'Ana'}:nombre:, ¿lista?`;

describe('idioma: elección', () => {
  it('usa la preferencia guardada antes que el navegador', () => {
    expect(elegirIdioma('pt-BR', ['en-US'])).toBe('pt-BR');
    expect(elegirIdioma('en', ['es-PE'])).toBe('en');
  });

  it('sin preferencia usa el idioma del navegador; si no lo tenemos, español', () => {
    expect(elegirIdioma(null, ['en-GB', 'es'])).toBe('en');
    expect(elegirIdioma(null, ['pt-PT'])).toBe('pt-BR');
    expect(elegirIdioma(null, ['pt'])).toBe('pt-BR');
    expect(elegirIdioma(null, ['fr-FR', 'de'])).toBe('es');
    expect(elegirIdioma(null, [])).toBe('es');
    expect(elegirIdioma('klingon', ['fr', 'en'])).toBe('en');
  });

  it('lee y guarda la preferencia sin romperse si el almacenamiento falla', () => {
    const roto = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(idiomaGuardado(roto)).toBeNull();
    expect(guardarIdioma('en', roto)).toBe(false);
    const mapa = new Map<string, string>();
    const bueno = { getItem: (k: string) => mapa.get(k) ?? null, setItem: (k: string, v: string) => void mapa.set(k, v) };
    expect(guardarIdioma('pt-BR', bueno)).toBe(true);
    expect(mapa.get(CLAVE_IDIOMA)).toBe('pt-BR');
    expect(idiomaGuardado(bueno)).toBe('pt-BR');
    mapa.set(CLAVE_IDIOMA, 'xx');
    expect(idiomaGuardado(bueno)).toBeNull();
  });
});

describe('idioma: carga antes del arranque', () => {
  afterEach(async () => {
    clearTranslations();
    await cargarIdioma({ guardado: 'es', navegador: [] });
  });

  it('en español no descarga nada y deja el texto fuente', async () => {
    const f = respuesta({ translations: {} });
    const idioma = await cargarIdioma({ guardado: null, navegador: ['es-PE'], fetch: f });
    expect(idioma.codigo).toBe('es');
    expect(f).not.toHaveBeenCalled();
    expect(localeActual()).toBe('es-PE');
    expect(saludo()).toBe('Hola Ana, ¿lista?');
    expect(document.documentElement.lang).toBe('es-PE');
  });

  it('carga las traducciones de /i18n/<idioma>.json y las aplica a $localize', async () => {
    const f = respuesta({ locale: 'en', translations: { 'prueba.saludo': 'Hi {$nombre}, ready?' } });
    const idioma = await cargarIdioma({ guardado: 'en', navegador: [], fetch: f });
    expect(f).toHaveBeenCalledWith('i18n/en.json', { cache: 'no-cache' });
    expect(idioma.codigo).toBe('en');
    expect(localeActual()).toBe('en-US');
    expect(saludo()).toBe('Hi Ana, ready?');
    expect(document.documentElement.lang).toBe('en-US');
  });

  it('un mensaje sin traducir sale en español (no rompe la pantalla)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cargarIdioma({ guardado: 'en', navegador: [], fetch: respuesta({ translations: {} }) });
    expect(saludo()).toBe('Hola Ana, ¿lista?');
    warn.mockRestore();
  });

  it.each([
    ['el archivo no existe (404)', respuesta({ error: 'no' }, 404)],
    ['el servidor devuelve index.html en vez del JSON', respuesta('<!doctype html><html></html>')],
    ['el JSON no tiene traducciones', respuesta({ locale: 'en' })],
    ['la red falla', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch],
  ])('vuelve a español si %s', async (_caso, f) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const idioma = await cargarIdioma({ guardado: 'pt-BR', navegador: [], fetch: f });
    expect(idioma.codigo).toBe('es');
    expect(localeActual()).toBe('es-PE');
    expect(saludo()).toBe('Hola Ana, ¿lista?');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('cambiar de idioma guarda la preferencia y recarga', async () => {
    const recargar = vi.fn();
    cambiarIdioma('pt-BR', recargar);
    expect(recargar).toHaveBeenCalledOnce();
    expect(idiomaGuardado()).toBe('pt-BR');
    localStorage.removeItem(CLAVE_IDIOMA);
  });

  it('las etiquetas perezosas se traducen al leerlas, no al cargar el módulo', async () => {
    const mapa = etiquetas(() => ({ a: $localize`:@@prueba.etiqueta:Pendiente` }));
    await cargarIdioma({
      guardado: 'en',
      navegador: [],
      fetch: respuesta({ translations: { 'prueba.etiqueta': 'Pending' } }),
    });
    expect(mapa['a']).toBe('Pending');
    expect(Object.entries(mapa)).toEqual([['a', 'Pending']]);
    expect('a' in mapa).toBe(true);
  });
});

describe('idioma: formatos por locale', () => {
  afterEach(async () => {
    clearTranslations();
    await cargarIdioma({ guardado: 'es', navegador: [] });
  });

  it('español (Perú): fechas, soles y listas como antes', () => {
    expect(fmtDate('2026-10-01')).toMatch(/01 oct\.? 2026/);
    expect(fmtDateTime('2026-10-01T15:30:00')).toBe('01/10/2026, 10:30:00');
    expect(fmtSoles(34.5)).toBe('S/ 34.50');
    expect(fmtSoles(69)).toBe('S/ 69');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b y c');
  });

  it('inglés: formato de EE. UU., moneda PEN y «and»', async () => {
    await cargarIdioma({ guardado: 'en', navegador: [], fetch: respuesta({ translations: {} }) });
    expect(fmtDate('2026-10-01')).toBe('Oct 01, 2026');
    expect(fmtDateTime('2026-10-01T15:30:00')).toBe('10/01/2026, 10:30:00');
    expect(fmtSoles(34.5)).toBe('PEN 34.50');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(formatNumber(1234.5, localeActual(), '1.2-2')).toBe('1,234.50');
  });

  it('portugués de Brasil: registra los datos de Angular (pipes y plurales de ICU)', async () => {
    await cargarIdioma({ guardado: 'pt-BR', navegador: [], fetch: respuesta({ translations: {} }) });
    expect(idiomaActual().locale).toBe('pt-BR');
    expect(getLocaleId('pt-BR')).toBe('pt');
    expect(formatNumber(1234.5, 'pt-BR', '1.2-2')).toBe('1.234,50');
    expect(formatDate('2026-10-01T12:00:00Z', 'mediumDate', 'pt-BR', 'UTC')).toBe('1 de out. de 2026');
    expect(fmtDate('2026-10-01')).toBe('01 de out. de 2026');
    expect(fmtSoles(34.5)).toBe('PEN 34,50');
    expect(joinList(['a', 'b'])).toBe('a e b');
  });
});
