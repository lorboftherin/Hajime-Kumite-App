/**
 * Enlace al perfil público de un competidor (`/competidor/<public_id>`), o null si
 * no hay identificador público (p. ej. un equipo o una respuesta que no lo trae).
 *
 * Pensado para el vivo público y los resultados: `[routerLink]="personLink(x.public_id)"`
 * (con null, Angular deja el nombre sin enlace).
 */
export function personLink(publicId: string | null | undefined): string[] | null {
  return publicId ? ['/competidor', publicId] : null;
}
