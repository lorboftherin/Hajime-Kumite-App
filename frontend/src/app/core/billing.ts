import { fmtSoles } from './format';
import { BillingAlert, PaymentOut } from './models';
import { etiquetas } from './i18n/etiquetas';

/** Culqi Checkout v4: se carga desde su CDN oficial SOLO en la página de pago. */
export const CULQI_CHECKOUT_JS = 'https://checkout.culqi.com/js/v4';

export const PAYMENT_STATUS: Record<PaymentOut['status'], string> = etiquetas(() => ({
  pending: $localize`:@@cobro.pendiente:Pendiente`,
  approved: $localize`:@@cobro.aprobado:Aprobado`,
  rejected: $localize`:@@cobro.rechazado:Rechazado`,
  refunded: $localize`:@@cobro.reembolsado:Reembolsado`,
}));

export const INVOICE_STATUS: Record<string, string> = etiquetas(() => ({
  pending: $localize`:@@cobro.enviado:Enviado`,
  accepted: $localize`:@@cobro.aceptado-sunat:Aceptado por SUNAT`,
  rejected: $localize`:@@cobro.rechazado-sunat:Rechazado por SUNAT`,
  error: $localize`:@@cobro.error:Con error`,
}));

export const PROVIDER_LABEL: Record<string, string> = etiquetas(() => ({
  manual: $localize`:@@cobro.manual:Manual`,
  mercadopago: 'Mercado Pago',
  culqi: 'Culqi',
  coupon: $localize`:@@cobro.cupon:Cupón`,
}));

/** Céntimos de sol → «S/ 69» o «S/ 34.50» (formato del idioma: ver fmtSoles). */
export function penFromCents(cents: number | null | undefined): string {
  return fmtSoles((cents ?? 0) / 100);
}

/** Texto del aviso del encabezado («tu plan vence en N días»). */
export function alertText(a: BillingAlert): string {
  const who = a.organization_name
    ? `${a.plan_name} de ${a.organization_name}`
    : $localize`:@@cobro.plan:Tu plan ${a.plan_name}:plan_name:`;
  if (a.in_grace) {
    const d = a.days_left === 1 ? $localize`:@@cobro.1-dia:1 día` : $localize`:@@cobro.dias:${a.days_left}:dias: días`;
    return $localize`:@@cobro.pago-no-completo-tienes-gracia:${who}:who:: el pago no se completó. Tienes ${d}:d: de gracia antes de perder el acceso.`;
  }
  if (a.days_left <= 0) return $localize`:@@cobro.vence-hoy:${who}:who: vence hoy.`;
  if (a.days_left === 1) return $localize`:@@cobro.vence-1-dia:${who}:who: vence en 1 día.`;
  return $localize`:@@cobro.vence-dias:${who}:who: vence en ${a.days_left}:dias: días.`;
}

/** Comprobante como «B001-00000012» (serie y número de 8 dígitos). */
export function invoiceNumber(serie: string, numero: number): string {
  return `${serie}-${String(numero).padStart(8, '0')}`;
}

interface CulqiGlobal {
  publicKey: string;
  settings(opts: Record<string, unknown>): void;
  options(opts: Record<string, unknown>): void;
  open(): void;
  close(): void;
  token?: { id: string; email: string };
  error?: { user_message?: string; merchant_message?: string };
}

declare global {
  interface Window {
    Culqi?: CulqiGlobal;
    culqi?: () => void;
  }
}

let culqiLoading: Promise<CulqiGlobal> | null = null;

/** Inserta el script de Culqi Checkout una sola vez y devuelve el objeto global. */
export function loadCulqi(doc: Document = document): Promise<CulqiGlobal> {
  if (window.Culqi) return Promise.resolve(window.Culqi);
  if (culqiLoading) return culqiLoading;
  culqiLoading = new Promise<CulqiGlobal>((resolve, reject) => {
    const s = doc.createElement('script');
    s.src = CULQI_CHECKOUT_JS;
    s.async = true;
    s.onload = () =>
      window.Culqi ? resolve(window.Culqi) : reject(new Error($localize`:@@cobro.culqi-checkout-no-cargo:Culqi Checkout no cargó`));
    s.onerror = () => {
      culqiLoading = null;
      reject(new Error($localize`:@@cobro.no-pudo-cargar-culqi-checkout:No se pudo cargar Culqi Checkout. Revisa tu conexión.`));
    };
    doc.head.appendChild(s);
  });
  return culqiLoading;
}

/**
 * Abre Culqi Checkout y resuelve con el token (o null si el usuario cerró la ventana).
 * La tarjeta va directo a Culqi: Hajime solo recibe el token de un solo uso.
 */
export function openCulqi(
  culqi: CulqiGlobal,
  cfg: { publicKey: string; title: string; description: string; amountCents: number },
): Promise<{ token: string; email: string } | { error: string }> {
  return new Promise((resolve) => {
    culqi.publicKey = cfg.publicKey;
    culqi.settings({
      title: cfg.title,
      currency: 'PEN',
      description: cfg.description,
      amount: cfg.amountCents,
    });
    culqi.options({
      lang: 'es',
      installments: false,
      paymentMethods: { tarjeta: true, yape: true },
    });
    window.culqi = () => {
      if (culqi.token) {
        const t = culqi.token;
        culqi.close();
        resolve({ token: t.id, email: t.email });
      } else {
        resolve({ error: culqi.error?.user_message || $localize`:@@cobro.no-pudo-procesar-pago:No se pudo procesar el pago` });
      }
    };
    culqi.open();
  });
}
