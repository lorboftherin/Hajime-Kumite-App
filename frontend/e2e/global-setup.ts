// Siembra por API lo que comparten los escenarios: un organizador y una
// plantilla pequeña. Cada escenario crea además sus propios datos.
import type { FullConfig } from '@playwright/test';
import { Api } from './apoyo/api';
import { guardarEstado } from './apoyo/estado';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0].use.baseURL as string;
  const admin = { usuario: 'admin', clave: process.env['HAJIME_E2E_ADMIN_PASSWORD'] as string };
  const { api } = await Api.ingresar(baseURL, admin.usuario, admin.clave);

  const organizador = { usuario: 'organizador-e2e', clave: 'organiza-e2e-123' };
  await api.usuario({ ...organizador, rol: { role: 'organizer', scope_type: 'global' } });

  const nombre = 'Plantilla E2E';
  const plantilla = await api.post('/templates', {
    name: nombre,
    description: 'Plantilla pequeña de las pruebas de extremo a extremo',
    items: [
      {
        code: 'KU-SEN-M',
        name: 'Kumite Senior Masculino',
        modality: 'kumite',
        sex: 'M',
        age_min: 18,
        duration_seconds: 120,
        sort_order: 1,
      },
      {
        code: 'KA-SEN-F',
        name: 'Kata Senior Femenino',
        modality: 'kata',
        sex: 'F',
        age_min: 18,
        kata_method: 'flags',
        sort_order: 2,
      },
    ],
  });

  guardarEstado({ baseURL, admin, organizador, plantilla: { id: plantilla.id, nombre } });
}
