import { MatchSummary } from '../../core/models';

/**
 * Tarjeta del resultado para compartir en redes (1080×1080), como las
 * historias de CricHeroes. Se dibuja en un canvas con la identidad de Hajime:
 * papel washi, ensō aka/ao, nombres en Mincho y sello 勝 del ganador.
 * Devuelve true si se abrió el menú de compartir del teléfono; false si se descargó.
 */
export async function shareMatchCard(d: MatchSummary, resultText: string): Promise<boolean> {
  const S = 1080;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  if (!g) throw new Error('canvas');
  const display = "'Shippori Mincho B1', serif";
  const ui = "'Zen Kaku Gothic New', system-ui, sans-serif";
  await Promise.all([document.fonts.load(`700 64px ${display}`), document.fonts.load(`700 32px ${ui}`)]).catch(() => undefined);

  // Papel y marco
  g.fillStyle = '#F5F0E6';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#E3DBCB';
  g.lineWidth = 2;
  g.strokeRect(40, 40, S - 80, S - 80);

  // Ensō de dos trazos (arcos gruesos)
  g.lineCap = 'round';
  g.lineWidth = 26;
  g.strokeStyle = '#BE3B2C';
  g.beginPath();
  g.arc(S / 2, 250, 150, (104 * Math.PI) / 180, (258 * Math.PI) / 180);
  g.stroke();
  g.strokeStyle = '#24477A';
  g.beginPath();
  g.arc(S / 2, 250, 150, (-98 * Math.PI) / 180, (52 * Math.PI) / 180);
  g.stroke();

  const center = (text: string, y: number, font: string, color: string) => {
    g.font = font;
    g.fillStyle = color;
    g.textAlign = 'center';
    g.fillText(fit(g, text, S - 160), S / 2, y);
  };
  // Marcador dentro del ensō
  center(`${d.aka.score}–${d.ao.score}`, 280, `800 84px ${ui}`, '#1E1C1A');

  center((d.tournament?.name ?? '').toUpperCase(), 450, `600 26px ${ui}`, '#8A8377');
  center(d.category.name, 500, `700 38px ${display}`, '#4A463F');

  const side = (color: 'aka' | 'ao', y: number) => {
    const s = d[color];
    const won = d.match.winner === color;
    g.fillStyle = color === 'aka' ? '#B8322A' : '#24477A';
    g.fillRect(120, y - 64, 10, 110);
    g.textAlign = 'left';
    g.font = `800 24px ${ui}`;
    g.fillStyle = '#8A8377';
    g.fillText(color === 'aka' ? 'AKA' : 'AO', 160, y - 30);
    const nameMax = won ? 540 : 660; // deja lugar al sello 勝
    fitFont(g, s.name ?? '—', nameMax, 60, 36, (px) => `700 ${px}px ${display}`);
    g.fillStyle = won ? '#1E1C1A' : '#4A463F';
    g.fillText(fit(g, s.name ?? '—', nameMax), 160, y + 30);
    g.font = `500 28px ${ui}`;
    g.fillStyle = '#8A8377';
    g.fillText(fit(g, s.dojo ?? '', 640), 160, y + 70);
    g.textAlign = 'right';
    g.font = `900 96px ${ui}`;
    g.fillStyle = '#1E1C1A';
    g.fillText(String(s.score), S - 130, y + 30);
    if (won) {
      g.save();
      g.translate(S - 250, y - 4);
      g.rotate((-4 * Math.PI) / 180);
      g.fillStyle = '#B8322A';
      roundRect(g, -40, -40, 80, 80, 8);
      g.fill();
      g.fillStyle = '#FFFFFF';
      g.font = `800 50px ${display}`;
      g.textAlign = 'center';
      g.fillText('勝', 0, 18);
      g.restore();
    }
  };
  side('aka', 640);
  side('ao', 820);

  center(resultText, 950, `500 30px ${ui}`, '#4A463F');
  g.textAlign = 'center';
  g.font = `700 28px ${display}`;
  g.fillStyle = '#8A8377';
  g.fillText($localize`:@@combate.compartir.hajime-torneos-karate:Hajime · Torneos de karate`, S / 2, 1010);

  const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('blob'))), 'image/png'));
  const file = new File([blob], `hajime-${d.match.code}.png`, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${d.category.name} · ${d.match.code}` });
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

/** Achica la fuente (de ``from`` a ``to`` px) hasta que el texto quepa; si no, queda en ``to``. */
function fitFont(
  g: CanvasRenderingContext2D,
  text: string,
  max: number,
  from: number,
  to: number,
  font: (px: number) => string,
): void {
  for (let px = from; px >= to; px -= 2) {
    g.font = font(px);
    if (g.measureText(text).width <= max) return;
  }
}

function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
