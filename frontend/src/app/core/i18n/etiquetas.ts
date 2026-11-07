/**
 * Diccionario de etiquetas que se arma la primera vez que se lee, no al cargar
 * el módulo: así sus $localize se resuelven con las traducciones ya cargadas
 * (main.ts las carga después de evaluar los módulos). Se usa como un objeto
 * normal: `ETIQUETA[codigo]`, `Object.entries(ETIQUETA)`, `codigo in ETIQUETA`.
 */
export function etiquetas<T extends object>(crear: () => T): T {
  return perezoso({} as T, crear);
}

/** Lo mismo para una lista (`@for`, `.map`, `Array.isArray` funcionan igual). */
export function lista<T>(crear: () => T[]): T[] {
  return perezoso([] as T[], crear);
}

function perezoso<T extends object>(destino: T, crear: () => T): T {
  let valor: T | undefined;
  const v = (): T => (valor ??= crear());
  return new Proxy(destino, {
    get: (_, k) => Reflect.get(v(), k),
    has: (_, k) => Reflect.has(v(), k),
    ownKeys: () => Reflect.ownKeys(v()),
    getOwnPropertyDescriptor: (_, k) => Reflect.getOwnPropertyDescriptor(v(), k),
    set: () => false,
  });
}
