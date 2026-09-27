import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** API BarcodeDetector del navegador (Chrome/Android, Safari 17+); sin librerías. */
interface DetectedCode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

/** ¿Hay lector QR con cámara en este navegador? */
export function qrScanSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'BarcodeDetector' in window &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/**
 * Lector de QR con la cámara trasera. Emite el texto del primer código leído
 * y se detiene. Si el navegador no tiene BarcodeDetector, la mesa sigue
 * pudiendo tipear el código (o usar un lector USB, que «tipea» y da Enter).
 */
@Component({
  selector: 'app-qr-scanner',
  template: `
    <div class="scanner">
      <video #video playsinline muted></video>
      <div class="frame" aria-hidden="true"></div>
    </div>
    @if (error()) {
      <p class="alert warn small">{{ error() }}</p>
    } @else {
      <p i18n="@@acreditacion.qr.apunta-camara-qr-credencial" class="hint">Apunta la cámara al QR de la credencial.</p>
    }
  `,
  styles: `
    .scanner {
      position: relative;
      aspect-ratio: 4 / 3;
      background: #000;
      border-radius: var(--radius);
      overflow: hidden;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .frame {
      position: absolute;
      inset: 18% 26%;
      border: 3px solid rgba(255, 255, 255, 0.85);
      border-radius: var(--radius);
      box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.25);
    }
  `,
})
export class QrScanner implements OnDestroy {
  readonly scanned = output<string>();
  readonly error = signal('');
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private done = false;

  constructor() {
    afterNextRender(() => this.start());
  }

  private async start(): Promise<void> {
    if (!qrScanSupported()) {
      this.error.set(
        $localize`:@@acreditacion.qr.este-navegador-no-puede-leer:Este navegador no puede leer códigos QR con la cámara. Escribe el código de la credencial.`,
      );
      return;
    }
    try {
      const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
      const detector = new Ctor({ formats: ['qr_code'] });
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      const el = this.video().nativeElement;
      el.srcObject = this.stream;
      await el.play();
      this.timer = setInterval(async () => {
        if (this.done || el.readyState < 2) return;
        try {
          const found = await detector.detect(el);
          if (found.length && !this.done) {
            this.done = true;
            this.stop();
            this.scanned.emit(found[0].rawValue);
          }
        } catch {
          /* cuadro sin código: se sigue intentando */
        }
      }, 250);
    } catch {
      this.error.set(
        $localize`:@@acreditacion.qr.no-pudo-abrir-camara-permiso:No se pudo abrir la cámara (¿permiso denegado?). Escribe el código de la credencial.`,
      );
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  ngOnDestroy(): void {
    this.stop();
  }
}
