// Lógica pura de los avisos push (qué soporta el dispositivo y qué mensaje mostrar).
// Probada en push-logic.spec.ts. Ver docs/avisos-push.md.

/** Qué puede hacer este dispositivo con los avisos. */
export type PushSupport =
  | 'ok' // navegador con Web Push y service worker: se puede suscribir
  | 'app' // app de Android (Capacitor): el WebView no tiene Web Push
  | 'ios-install' // iPhone/iPad en Safari sin instalar: iOS solo da push a la app instalada
  | 'unsupported' // navegador sin Push API ni notificaciones
  | 'no-sw' // sin service worker (desarrollo o navegación privada)
  | 'server-off' // el servidor no tiene claves VAPID
  | 'denied'; // la persona bloqueó las notificaciones del sitio

export interface PushEnv {
  mobileApp: boolean;
  swEnabled: boolean;
  pushManager: boolean;
  notification: boolean;
  ios: boolean;
  standalone: boolean;
  permission: NotificationPermission | 'unknown';
}

export function pushSupport(env: PushEnv, serverEnabled: boolean | null): PushSupport {
  if (env.mobileApp) return 'app';
  if (env.ios && !env.standalone) return 'ios-install';
  if (!env.pushManager || !env.notification) return 'unsupported';
  if (!env.swEnabled) return 'no-sw';
  if (serverEnabled === false) return 'server-off';
  if (env.permission === 'denied') return 'denied';
  return 'ok';
}

export const PUSH_MESSAGES: Record<PushSupport, string> = {
  ok: '',
  app:
    'La app de Android todavía no recibe avisos. Instala Hajime desde el navegador para ' +
    'recibirlos: ábrelo en Chrome y elige «Instalar app» o «Agregar a la pantalla principal».',
  'ios-install':
    'En iPhone y iPad los avisos solo llegan con Hajime instalado: en Safari toca Compartir → ' +
    '«Agregar a pantalla de inicio», abre Hajime desde ese ícono y vuelve a tocar «Avisarme» ' +
    '(iOS 16.4 o superior).',
  unsupported:
    'Este navegador no puede recibir avisos. Prueba con Chrome, Edge, Firefox o Safari al día.',
  'no-sw':
    'Los avisos necesitan la versión instalable de Hajime (no funcionan en navegación privada).',
  'server-off': 'Los avisos no están activos en este servidor.',
  denied:
    'Bloqueaste las notificaciones de Hajime. Actívalas en los ajustes del sitio del navegador ' +
    '(el candado junto a la dirección) y vuelve a intentarlo.',
};

/** iPhone, iPad o iPod (el iPad moderno se presenta como Mac con pantalla táctil). */
export function isIos(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Lee el entorno del navegador (con cuidado: cualquier acceso puede fallar). */
export function detectEnv(swEnabled: boolean, mobileApp: boolean): PushEnv {
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  const win: Window | undefined = typeof window === 'undefined' ? undefined : window;
  const standalone = safely(
    () =>
      !!win?.matchMedia?.('(display-mode: standalone)').matches ||
      (nav as Navigator & { standalone?: boolean })?.standalone === true,
    false,
  );
  const permission = safely<PushEnv['permission']>(
    () => (typeof Notification === 'undefined' ? 'unknown' : Notification.permission),
    'unknown',
  );
  return {
    mobileApp,
    swEnabled,
    pushManager: !!win && 'PushManager' in win,
    notification: typeof Notification !== 'undefined',
    ios: isIos(nav?.userAgent ?? '', nav?.maxTouchPoints ?? 0),
    standalone,
    permission,
  };
}

/** Lo que identifica la suscripción ante el servidor: endpoint y secreto `auth`. */
export interface PushRef {
  endpoint: string;
  auth: string;
}

export function pushRef(sub: PushSubscriptionJSON | null | undefined): PushRef | null {
  const auth = sub?.keys?.['auth'];
  return sub?.endpoint && auth ? { endpoint: sub.endpoint, auth } : null;
}

/** Agrega o quita una clave (conjunto nuevo, para las señales). */
export function toggled<T>(set: ReadonlySet<T>, value: T, on = !set.has(value)): Set<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

/** Solo rutas internas de la app (`/t/…`): el aviso nunca abre otro sitio. */
export function safeUrl(url: unknown): string | null {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : null;
}

export interface PushPreferences {
  turn: boolean;
  results: boolean;
  medals: boolean;
  account: boolean;
}

export interface PushState {
  subscribed: boolean;
  account: boolean;
  preferences: PushPreferences;
  keys: string[];
  person_ids: number[];
  dojo_ids: number[];
}

export const EMPTY_PUSH_STATE: PushState = {
  subscribed: false,
  account: false,
  preferences: { turn: true, results: true, medals: true, account: true },
  keys: [],
  person_ids: [],
  dojo_ids: [],
};

export const PREFERENCE_LABELS: { key: keyof PushPreferences; label: string; hint: string }[] = [
  {
    key: 'turn',
    label: 'Te toca pronto',
    hint: '«Te toca en ~3 combates» y «¡A tatami!» cuando su combate es el siguiente.',
  },
  { key: 'results', label: 'Resultados', hint: 'Ganó o perdió, contra quién y el marcador.' },
  { key: 'medals', label: 'Medallas', hint: 'Oro, plata o bronce al cerrar la categoría.' },
  {
    key: 'account',
    label: 'Mi cuenta',
    hint: 'Inscripciones revisadas por el organizador y perfiles aprobados.',
  },
];
