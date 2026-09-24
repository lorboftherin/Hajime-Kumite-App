/** Lee el campo `exp` (segundos UNIX) de un JWT sin verificar la firma. null si no se puede. */
export function jwtExpiresAt(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    );
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
