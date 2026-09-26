// Datos de partida que comparten varios escenarios, creados por la API con
// nombres únicos: cada prueba tiene su propio torneo y no depende de las demás.
import { Api, type Json, unico } from './api';

export interface TorneoListo {
  id: string;
  torneo: Json;
  tatami: Json;
  categoria: Json;
  llave: Json;
  /** Inscripciones en el orden en que se crearon. */
  inscripciones: Json[];
  /** Nombres «Nombre Apellido» de los competidores, en el mismo orden. */
  nombres: string[];
  operador: { usuario: string; clave: string };
}

export interface OpcionesTorneo {
  competidores?: number;
  modalidad?: 'kumite' | 'kata';
  /** Kumite: duración del combate en segundos. */
  duracion?: number;
  /** Kata: banderas (flags) o puntaje (scores). */
  kata?: 'flags' | 'scores';
  /** Estado final del torneo (por defecto, en curso). */
  estado?: 'registration_open' | 'registration_closed' | 'in_progress';
  /** Genera la llave y arma la cola del tatami (por defecto, sí). */
  conLlave?: boolean;
  extraTorneo?: Json;
}

/**
 * Torneo de prueba con un tatami, una categoría con N competidores de dojos
 * distintos, llave generada, la categoría en la cola del tatami, un operador de
 * mesa de ese tatami y el torneo en curso.
 */
export async function torneoListo(admin: Api, opciones: OpcionesTorneo = {}): Promise<TorneoListo> {
  const id = unico();
  const n = opciones.competidores ?? 4;
  const modalidad = opciones.modalidad ?? 'kumite';
  let torneo = await admin.torneo(`Torneo E2E ${id}`, opciones.extraTorneo ?? {});
  torneo = await admin.estado(torneo.id, 'registration_open');
  const tatami = torneo.tatamis[0];
  const categoria = await admin.categoria(torneo.id, {
    code: `E2E-${id}`.slice(0, 40),
    name: modalidad === 'kumite' ? `Kumite E2E ${id}` : `Kata E2E ${id}`,
    modality: modalidad,
    sex: 'M',
    age_min: 18,
    ...(modalidad === 'kumite'
      ? { duration_seconds: opciones.duracion ?? 30 }
      : {
          kata_method: opciones.kata ?? 'flags',
          kata_structure: 'bracket',
          kata_judges: opciones.kata === 'scores' ? 5 : 3,
        }),
  });
  const dojos: Json[] = [];
  for (let i = 0; i < Math.min(n, 4); i++)
    dojos.push(await admin.dojo(`Dojo ${String.fromCharCode(65 + i)} ${id}`));
  const nombres: string[] = [];
  const inscripciones: Json[] = [];
  for (let i = 0; i < n; i++) {
    const nombre = `Luchador${String.fromCharCode(65 + i)}`;
    const apellido = `E2e${id}`;
    const p = await admin.persona({
      nombres: nombre,
      apellidos: apellido,
      dojoId: dojos[i % dojos.length].id,
      nacimiento: `199${i % 10}-0${(i % 9) + 1}-1${i % 10}`,
    });
    nombres.push(`${nombre} ${apellido}`);
    inscripciones.push(await admin.inscribir(torneo.id, p.id, categoria.id));
  }
  const operador = { usuario: `mesa-${id}`, clave: 'mesa-e2e-123' };
  await admin.usuario({
    ...operador,
    rol: { role: 'table_operator', scope_type: 'tatami', scope_id: tatami.id },
  });
  let llave: Json = null;
  if (opciones.conLlave !== false) {
    await admin.estado(torneo.id, 'registration_closed');
    llave = await admin.llave(categoria.id);
    await admin.cola(tatami.id, [categoria.id]);
    if ((opciones.estado ?? 'in_progress') === 'in_progress')
      await admin.estado(torneo.id, 'in_progress');
  } else if (opciones.estado && opciones.estado !== 'registration_open') {
    await admin.estado(torneo.id, 'registration_closed');
    if (opciones.estado === 'in_progress') await admin.estado(torneo.id, 'in_progress');
  }
  torneo = await admin.get(`/tournaments/${torneo.id}`);
  return { id, torneo, tatami, categoria, llave, inscripciones, nombres, operador };
}

/** Nombre del competidor de una inscripción. */
export function nombreDe(t: TorneoListo, registrationId: number | null): string {
  const i = t.inscripciones.findIndex((r) => r.id === registrationId);
  return i >= 0 ? t.nombres[i] : '';
}

/** Combates de la llave por código (R1-1, R2-1…). */
export async function combates(admin: Api, categoriaId: number): Promise<Record<string, Json>> {
  const b = await admin.get(`/categories/${categoriaId}/bracket`);
  return Object.fromEntries(b.matches.map((m: Json) => [m.code, m]));
}
