import { Meta, Title } from '@angular/platform-browser';
import { localeActual } from '../../core/i18n/idioma';

/** Imagen para compartir: el logo de Hajime (512×512, en `public/icons`). */
export const SHARE_IMAGE = 'icons/icon-512x512.png';

interface ShareTournament {
  name: string;
  start_date: string;
  venue?: string;
  city?: string;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(localeActual(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Título, descripción e imagen para compartir la página pública (Open Graph y
 * Twitter). Sin SSR: los ven los navegadores y los buscadores que ejecutan
 * JavaScript; las vistas previas de WhatsApp o Facebook leen el index.html,
 * que trae unas etiquetas genéricas de Hajime (ver docs/portal-publico.md).
 */
export function setShareMeta(
  meta: Meta,
  title: Title,
  t: ShareTournament,
  path: string,
  extra = '',
): void {
  const where = [t.venue, t.city].filter(Boolean).join(', ');
  const heading = extra ? `${extra} · ${t.name}` : t.name;
  const desc = `${fmtDay(t.start_date)}${where ? ` · ${where}` : ''}. Combates en vivo, horarios, llaves y resultados.`;
  const url = `${location.origin}${path}`;
  const image = `${location.origin}/${SHARE_IMAGE}`;
  title.setTitle(`${heading} · Hajime en vivo`);
  const tags: Array<[string, string, 'name' | 'property']> = [
    ['description', desc, 'name'],
    ['og:type', 'website', 'property'],
    ['og:site_name', 'Hajime', 'property'],
    ['og:title', heading, 'property'],
    ['og:description', desc, 'property'],
    ['og:url', url, 'property'],
    ['og:image', image, 'property'],
    ['twitter:card', 'summary', 'name'],
    ['twitter:title', heading, 'name'],
    ['twitter:description', desc, 'name'],
    ['twitter:image', image, 'name'],
  ];
  for (const [key, content, attr] of tags) {
    meta.updateTag({ [attr]: key, content }, `${attr}="${key}"`);
  }
}
