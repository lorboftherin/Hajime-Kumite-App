import { Routes } from '@angular/router';

export const TOURNAMENT_TABS: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'resumen' },
  {
    path: 'resumen',
    loadComponent: () => import('./tabs/summary-tab').then((m) => m.SummaryTab),
    title: () => $localize`:@@rutas.resumen-hajime:Resumen · Hajime`,
  },
  {
    path: 'categorias',
    loadComponent: () => import('./tabs/categories-tab').then((m) => m.CategoriesTab),
    title: () => $localize`:@@rutas.categorias-hajime:Categorías · Hajime`,
  },
  {
    path: 'inscripciones',
    loadComponent: () => import('./tabs/registrations-tab').then((m) => m.RegistrationsTab),
    title: () => $localize`:@@rutas.inscripciones-hajime:Inscripciones · Hajime`,
  },
  {
    path: 'solicitudes',
    loadComponent: () => import('./tabs/requests-tab').then((m) => m.RequestsTab),
    title: () => $localize`:@@rutas.solicitudes-hajime:Solicitudes · Hajime`,
  },
  {
    path: 'importar',
    loadComponent: () => import('./tabs/import-tab').then((m) => m.ImportTab),
    title: () => $localize`:@@rutas.importar-excel-hajime:Importar Excel · Hajime`,
  },
  {
    path: 'acreditacion',
    loadComponent: () => import('./tabs/checkin-tab').then((m) => m.CheckinTab),
    title: () => $localize`:@@rutas.acreditacion-hajime:Acreditación · Hajime`,
  },
  {
    path: 'tatamis',
    loadComponent: () => import('./tabs/tatamis-tab').then((m) => m.TatamisTab),
    title: () => $localize`:@@rutas.tatamis-hajime:Tatamis · Hajime`,
  },
  {
    path: 'arbitros',
    loadComponent: () => import('./tabs/referees-tab').then((m) => m.RefereesTab),
    title: () => $localize`:@@rutas.arbitros-hajime:Árbitros · Hajime`,
  },
  {
    path: 'resultados',
    loadComponent: () => import('./tabs/results-tab').then((m) => m.ResultsTab),
    title: () => $localize`:@@rutas.resultados-hajime:Resultados · Hajime`,
  },
  {
    path: 'lideres',
    loadComponent: () => import('./tabs/leaders-tab').then((m) => m.LeadersTab),
    title: () => $localize`:@@rutas.lideres-hajime:Líderes · Hajime`,
  },
  {
    path: 'shadow',
    loadComponent: () => import('./tabs/shadow-tab').then((m) => m.ShadowTab),
    title: () => $localize`:@@rutas.shadow-mode-hajime:Shadow Mode · Hajime`,
  },
  {
    path: 'auditoria',
    loadComponent: () => import('./tabs/audit-tab').then((m) => m.AuditTab),
    title: () => $localize`:@@rutas.auditoria-hajime:Auditoría · Hajime`,
  },
];
