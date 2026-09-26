import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DialogService } from '../../core/dialog.service';
import { Bracket } from '../../core/models';
import { MutationOptions, MutationService } from '../../core/mutation.service';
import { ToastService } from '../../core/toast.service';

/**
 * Generar una llave con la acreditación en cuenta: si hay inscritos marcados
 * ausentes, el servidor advierte (ABSENT_ENTRANTS) y aquí se ofrece
 * «Excluir ausentes» (se retiran con «No se presentó») o incluirlos igual.
 * El resto de las advertencias sigue el flujo normal (motivo y override).
 */
@Injectable({ providedIn: 'root' })
export class BracketGenerator {
  private api = inject(ApiService);
  private mut = inject(MutationService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  async generate(
    cid: number,
    body: Record<string, unknown> = {},
    opts: MutationOptions = {},
  ): Promise<Bracket | undefined> {
    try {
      const res = await firstValueFrom(this.api.post<Bracket>(`/categories/${cid}/bracket`, body));
      if (opts.success) this.toast.ok(opts.success);
      return res;
    } catch (e) {
      const err = ApiError.from(e);
      const absent = err.warnings.find((w) => w.code === 'ABSENT_ENTRANTS');
      if (absent) {
        const choice = await this.dialog.choose({
          title: 'Hay inscritos ausentes',
          message: absent.message,
          choices: [
            {
              value: 'exclude',
              label: 'Excluir ausentes',
              hint: 'Se retiran con «No se presentó» y no entran en la llave',
              primary: true,
            },
            {
              value: 'include',
              label: 'Incluirlos igual',
              hint: 'Pide un motivo; quedan en la llave',
            },
          ],
        });
        if (choice === null) return undefined;
        return this.mut.post<Bracket>(
          `/categories/${cid}/bracket`,
          choice === 'exclude' ? { ...body, exclude_absent: true } : body,
          opts,
        );
      }
      if (err.code === 'WARNINGS')
        return this.mut.post<Bracket>(`/categories/${cid}/bracket`, body, opts);
      if (opts.onError && (await opts.onError(err))) return undefined;
      this.toast.error(err.fullMessage);
      return undefined;
    }
  }
}
