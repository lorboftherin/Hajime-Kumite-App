import { Routes } from '@angular/router';

export const TOURNAMENT_TABS: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'resumen' },
  { path: 'resumen', loadComponent: () => import('./tabs/summary-tab').then((m) => m.SummaryTab), title: 'Resumen · Hajime' },
  { path: 'categorias', loadComponent: () => import('./tabs/categories-tab').then((m) => m.CategoriesTab), title: 'Categorías · Hajime' },
  { path: 'inscripciones', loadComponent: () => import('./tabs/registrations-tab').then((m) => m.RegistrationsTab), title: 'Inscripciones · Hajime' },
  { path: 'importar', loadComponent: () => import('./tabs/import-tab').then((m) => m.ImportTab), title: 'Importar Excel · Hajime' },
  { path: 'tatamis', loadComponent: () => import('./tabs/tatamis-tab').then((m) => m.TatamisTab), title: 'Tatamis · Hajime' },
  { path: 'resultados', loadComponent: () => import('./tabs/results-tab').then((m) => m.ResultsTab), title: 'Resultados · Hajime' },
  { path: 'shadow', loadComponent: () => import('./tabs/shadow-tab').then((m) => m.ShadowTab), title: 'Shadow Mode · Hajime' },
  { path: 'auditoria', loadComponent: () => import('./tabs/audit-tab').then((m) => m.AuditTab), title: 'Auditoría · Hajime' },
];
