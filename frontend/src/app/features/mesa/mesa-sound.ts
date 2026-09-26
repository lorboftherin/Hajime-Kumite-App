// Señales de tiempo de la mesa: pitido generado con Web Audio (sin archivos) y vibración.
import { TimerCue } from './mesa-logic';

const MUTE_KEY = 'hajime.mesa.silencio';
const AUTO_YAME_KEY = 'hajime.mesa.yame-automatico';

/** Preferencias de la mesa guardadas en este dispositivo. */
export const MESA_PREFS = { mute: MUTE_KEY, autoYame: AUTO_YAME_KEY } as const;

export function readFlag(key: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* sin almacenamiento: vale solo en esta sesión */
  }
}

interface Tone {
  freq: number;
  start: number;
  dur: number;
}

/** Aviso de 15 s: un pitido corto y agudo. Fin: un tono largo (como la bocina de la mesa). */
const TONES: Record<TimerCue, Tone[]> = {
  warn: [{ freq: 1046, start: 0, dur: 0.22 }],
  end: [{ freq: 740, start: 0, dur: 1.6 }],
};

/** Vibración: breve en el aviso, larga en el fin del tiempo. */
export const VIBRATION: Record<TimerCue, number[]> = {
  warn: [250],
  end: [900, 200, 900],
};

type AudioCtor = typeof AudioContext;

/**
 * Pitidos con Web Audio. Los navegadores solo permiten sonar después de un gesto del
 * usuario: `unlock()` se llama en el primer toque de la mesa y deja el contexto listo.
 */
export class Beeper {
  private ctx: AudioContext | null = null;

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      this.ctx = Ctor ? new Ctor() : null;
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** Desbloquea el audio (debe llamarse dentro de un gesto: toque, clic o tecla). */
  unlock(): void {
    const ctx = this.context();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      // Un búfer mudo de una muestra termina de «activar» el audio en iOS.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* sin audio */
    }
  }

  play(cue: TimerCue): void {
    const ctx = this.context();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      const t0 = ctx.currentTime + 0.01;
      for (const t of TONES[cue]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square'; // se oye mejor que una senoidal con el ruido del coliseo
        osc.frequency.value = t.freq;
        const a = t0 + t.start;
        const b = a + t.dur;
        // Envolvente corta para que no «chasquee» al empezar ni al terminar.
        gain.gain.setValueAtTime(0.0001, a);
        gain.gain.exponentialRampToValueAtTime(0.3, a + 0.015);
        gain.gain.setValueAtTime(0.3, b - 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, b);
        osc.connect(gain).connect(ctx.destination);
        osc.start(a);
        osc.stop(b + 0.02);
      }
    } catch {
      /* sin audio */
    }
  }

  close(): void {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
