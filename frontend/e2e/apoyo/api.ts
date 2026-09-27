// Cliente mínimo de la API para preparar datos de las pruebas (como el Api de
// backend/tests/api/conftest.py). Usa fetch de Node: sirve igual en
// globalSetup que dentro de las pruebas.
import { randomUUID } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Json,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export interface Sesion {
  access_token: string;
  refresh_token: string | null;
  user: Json;
}

let contador = 0;
/** Sufijo único por prueba (nombres de torneos, dojos, usuarios…). */
export function unico(): string {
  contador += 1;
  return `${Date.now().toString(36)}${process.pid.toString(36)}${contador}`;
}

/** Hora de un evento de la mesa (ISO). */
export const ahora = () => new Date().toISOString();

export class Api {
  constructor(
    readonly baseURL: string,
    private token: string | null = null,
  ) {}

  static async ingresar(
    baseURL: string,
    usuario: string,
    clave: string,
  ): Promise<{ api: Api; sesion: Sesion }> {
    const anon = new Api(baseURL);
    const sesion = (await anon.post('/auth/login', {
      username: usuario,
      password: clave,
    })) as Sesion;
    return { api: new Api(baseURL, sesion.access_token), sesion };
  }

  async llamar(metodo: string, ruta: string, cuerpo?: unknown): Promise<Json> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${this.baseURL}/api/v1${ruta}`, {
      method: metodo,
      headers,
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const texto = await r.text();
    const datos = leerJson(texto);
    if (!r.ok) {
      throw new ApiError(
        r.status,
        datos,
        `${metodo} ${ruta} -> ${r.status}: ${texto.slice(0, 500)}`,
      );
    }
    return datos;
  }

  get(ruta: string): Promise<Json> {
    return this.llamar('GET', ruta);
  }
  post(ruta: string, cuerpo?: unknown): Promise<Json> {
    return this.llamar('POST', ruta, cuerpo ?? {});
  }
  patch(ruta: string, cuerpo: unknown): Promise<Json> {
    return this.llamar('PATCH', ruta, cuerpo);
  }
  put(ruta: string, cuerpo: unknown): Promise<Json> {
    return this.llamar('PUT', ruta, cuerpo);
  }

  // --- Atajos de dominio -------------------------------------------------

  dojo(nombre: string, corto?: string): Promise<Json> {
    return this.post('/dojos', {
      name: nombre,
      ...(corto ? { short_name: corto } : {}),
      city: 'Lima',
    });
  }

  /** Persona ficticia; `override` evita la advertencia de posibles duplicados. */
  persona(datos: {
    nombres: string;
    apellidos: string;
    dojoId: number | null;
    sexo?: 'M' | 'F';
    nacimiento?: string;
    grado?: string;
  }): Promise<Json> {
    return this.post('/persons', {
      first_names: datos.nombres,
      last_names: datos.apellidos,
      sex: datos.sexo ?? 'M',
      birth_date: datos.nacimiento ?? '2000-01-01',
      dojo_id: datos.dojoId,
      grade: datos.grado ?? '1 kyu',
      override: { reason: 'Datos de prueba e2e' },
    });
  }

  /**
   * Cuenta con un rol (opcional) ligada a una persona nueva. Si `cambiarClave`,
   * la contraseña inicial (asignada por el Admin) se cambia por `clave` para que
   * la cuenta no pida cambiarla al entrar.
   */
  async usuario(opciones: {
    usuario: string;
    clave: string;
    rol?: { role: string; scope_type: string; scope_id?: number | null };
    dojoId?: number | null;
    email?: string;
    cambiarClave?: boolean;
  }): Promise<{ usuario: string; clave: string; persona: Json; user: Json }> {
    const persona = await this.persona({
      nombres: 'Cuenta',
      apellidos: opciones.usuario,
      dojoId: opciones.dojoId ?? null,
    });
    const inicial = opciones.cambiarClave === false ? opciones.clave : `${opciones.clave}-inicial`;
    const user = await this.post('/users', {
      username: opciones.usuario,
      password: inicial,
      display_name: opciones.usuario,
      person_id: persona.id,
      email: opciones.email ?? null,
    });
    if (opciones.rol) await this.post(`/persons/${persona.id}/roles`, opciones.rol);
    if (opciones.cambiarClave !== false) {
      const { api } = await Api.ingresar(this.baseURL, opciones.usuario, inicial);
      await api.post('/auth/change-password', {
        current_password: inicial,
        new_password: opciones.clave,
      });
    }
    return { usuario: opciones.usuario, clave: opciones.clave, persona, user };
  }

  torneo(nombre: string, extra: Json = {}): Promise<Json> {
    return this.post('/tournaments', {
      name: nombre,
      start_date: hoyLima(),
      is_test: true,
      ...extra,
    });
  }

  async estado(tid: number, estado: string, reason?: string): Promise<Json> {
    const t = await this.get(`/tournaments/${tid}`);
    return this.patch(`/tournaments/${tid}/status`, { status: estado, version: t.version, reason });
  }

  categoria(tid: number, datos: Json): Promise<Json> {
    return this.post(`/tournaments/${tid}/categories`, datos);
  }

  inscribir(tid: number, personId: number, categoryId: number, extra: Json = {}): Promise<Json> {
    return this.post(`/tournaments/${tid}/registrations`, {
      person_id: personId,
      category_id: categoryId,
      override: { reason: 'Datos de prueba e2e' },
      ...extra,
    });
  }

  llave(cid: number, extra: Json = {}): Promise<Json> {
    return this.post(`/categories/${cid}/bracket`, { seed: 7, ...extra });
  }

  cola(tatamiId: number, categorias: number[]): Promise<Json> {
    return this.put(`/tatamis/${tatamiId}/queue`, { category_ids: categorias });
  }

  evento(mid: number, tipo: string, color?: string | null, valor?: number | null): Promise<Json> {
    return this.post(`/matches/${mid}/events`, {
      id: randomUUID(),
      type: tipo,
      at: ahora(),
      color: color ?? null,
      value: valor ?? null,
    });
  }
}

function leerJson(texto: string): Json {
  try {
    return texto ? JSON.parse(texto) : null;
  } catch {
    return texto;
  }
}

/** Fecha de hoy en Lima (AAAA-MM-DD), como la usa la app. */
export function hoyLima(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
}
