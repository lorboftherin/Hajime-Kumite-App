import { ApplicationRef, Injectable, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { concat, first, interval } from 'rxjs';
import { ToastService } from './toast.service';

/**
 * Versión instalable (PWA): avisa cuando hay una versión nueva y revisa cada
 * media hora. Recargar es decisión de la persona: en plena mesa no se
 * interrumpe un combate.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private sw = inject(SwUpdate);
  private toast = inject(ToastService);
  private app = inject(ApplicationRef);

  start(): void {
    if (!this.sw.isEnabled) return;
    this.sw.versionUpdates.subscribe((ev) => {
      if (ev.type === 'VERSION_READY') {
        this.toast.show(
          $localize`:@@actualizacion.hay-version-nueva-hajime-recarga:Hay una versión nueva de Hajime. Recarga la página para usarla.`,
          'info',
          15000,
        );
      } else if (ev.type === 'VERSION_INSTALLATION_FAILED') {
        this.toast.warn(
          $localize`:@@actualizacion.no-pudo-descargar-version-nueva:No se pudo descargar la versión nueva. Se sigue usando la actual.`,
        );
      }
    });
    const stable = this.app.isStable.pipe(first((s) => s));
    concat(stable, interval(30 * 60 * 1000)).subscribe(() =>
      this.sw.checkForUpdate().catch(() => {}),
    );
  }
}
