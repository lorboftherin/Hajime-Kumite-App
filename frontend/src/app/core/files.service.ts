import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError } from './api-error';
import { ApiService } from './api.service';
import { ToastService } from './toast.service';

/** Descargas/aperturas de archivos protegidos: se piden como Blob con el token y se abre un Object URL. */
@Injectable({ providedIn: 'root' })
export class FilesService {
  private api = inject(ApiService);
  private toast = inject(ToastService);

  async open(path: string, params?: Record<string, string | number | boolean>): Promise<void> {
    // Abrimos la pestaña antes del await para que el navegador no la bloquee como popup.
    const win = window.open('', '_blank');
    try {
      const blob = await firstValueFrom(this.api.blob(path, params));
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url;
      else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }

  async download(
    path: string,
    filename: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<void> {
    try {
      const blob = await firstValueFrom(this.api.blob(path, params));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      this.toast.error(ApiError.from(e).fullMessage);
    }
  }
}
