import { PublicProfile } from '../core/cuentas';

/**
 * Tarjeta del perfil público para compartir en redes (1080×1080), con la misma
 * identidad que la del combate (features/matches/share-card.ts): papel washi,
 * ensō aka/ao y medallas. Solo usa datos públicos (nombre abreviado si es menor).
 * Devuelve true si se abrió el menú de compartir del teléfono; false si se descargó.
 */
export async function shareProfileCard(p: PublicProfile, url: string): Promise<boolean> {
  const S = 1080;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  if (!g) throw new Error('canvas');
  const display = "'Shippori Mincho B1', serif";
  const ui = "'Zen Kaku Gothic New', system-ui, sans-serif";
  await Promise.all([
    document.fonts.load(`700 64px ${display}`),
    document.fonts.load(`700 32px ${ui}`),
  ]).catch(() => undefined);

  g.fillStyle = '#F5F0E6';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#E3DBCB';
  g.lineWidth = 2;
  g.strokeRect(40, 40, S - 80, S - 80);

  g.lineCap = 'round';
  g.lineWidth = 22;
  g.strokeStyle = '#BE3B2C';
  g.beginPath();
  g.arc(S / 2, 230, 120, (104 * Math.PI) / 180, (258 * Math.PI) / 180);
  g.stroke();
  g.strokeStyle = '#24477A';
  g.beginPath();
  g.arc(S / 2, 230, 120, (-98 * Math.PI) / 180, (52 * Math.PI) / 180);
  g.stroke();

  const center = (text: string, y: number, font: string, color: string) => {
    g.font = font;
    g.fillStyle = color;
    g.textAlign = 'center';
    g.fillText(fit(g, text, S - 160), S / 2, y);
  };
  center('選手', 262, `700 80px ${display}`, '#1E1C1A');
  center(p.name, 470, `700 76px ${display}`, '#1E1C1A');
  center(p.dojo ?? '', 530, `500 34px ${ui}`, '#4A463F');

  const medals: Array<[string, number, string]> = [
    [$localize`:@@perfil.compartir.oro:Oro`, p.medals.gold, '#C9A24B'],
    [$localize`:@@perfil.compartir.plata:Plata`, p.medals.silver, '#A3A6A8'],
    [$localize`:@@perfil.compartir.bronce:Bronce`, p.medals.bronze, '#9C6238'],
  ];
  medals.forEach(([label, n, color], i) => {
    const x = S / 2 + (i - 1) * 260;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, 680, 70, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.font = `800 64px ${ui}`;
    g.textAlign = 'center';
    g.fillText(String(n), x, 702);
    g.fillStyle = '#4A463F';
    g.font = `600 28px ${ui}`;
    g.fillText(label, x, 790);
  });
  const t = p.tournament_count;
  center(
    `${t} ${t === 1 ? $localize`:@@perfil.compartir.torneo-disputado:torneo disputado` : $localize`:@@perfil.compartir.torneos-disputados:torneos disputados`}`,
    880,
    `500 32px ${ui}`,
    '#4A463F',
  );
  center($localize`:@@perfil.compartir.hajime-torneos-karate:Hajime · Torneos de karate`, 1000, `700 28px ${display}`, '#8A8377');

  const blob: Blob = await new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('blob'))), 'image/png'),
  );
  const file = new File([blob], `hajime-${p.public_id}.png`, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: $localize`:@@perfil.compartir.hajime:${p.name}:name: · Hajime`, url });
      return true;
    } catch {
      /* cancelado: se descarga */
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return false;
}

function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}
