import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/auth.guard';
import { Shell } from './layout/shell';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/login/login').then((m) => m.LoginPage), title: 'Ingresar · Hajime' },
  {
    // Mesa de kumite: pantalla completa, sin navegación.
    path: 'mesa/:matchId',
    canActivate: [authGuard],
    loadComponent: () => import('./features/mesa/mesa').then((m) => m.MesaPage),
    title: 'Mesa · Hajime',
  },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'torneos' },
      {
        path: 'torneos',
        loadComponent: () => import('./features/tournaments/tournament-list').then((m) => m.TournamentListPage),
        title: 'Torneos · Hajime',
      },
      {
        path: 'torneos/:id',
        loadComponent: () => import('./features/tournaments/tournament-detail').then((m) => m.TournamentDetailPage),
        loadChildren: () => import('./features/tournaments/tournament.routes').then((m) => m.TOURNAMENT_TABS),
      },
      {
        path: 'categorias/:id/llave',
        loadComponent: () => import('./features/bracket/bracket-page').then((m) => m.BracketPage),
        title: 'Llave · Hajime',
      },
      {
        path: 'personas',
        loadComponent: () => import('./features/persons/person-list').then((m) => m.PersonListPage),
        title: 'Personas · Hajime',
      },
      {
        path: 'personas/:id',
        loadComponent: () => import('./features/persons/person-detail').then((m) => m.PersonDetailPage),
        title: 'Persona · Hajime',
      },
      {
        path: 'dojos',
        loadComponent: () => import('./features/dojos/dojo-list').then((m) => m.DojoListPage),
        title: 'Dojos · Hajime',
      },
      {
        path: 'plantillas',
        loadComponent: () => import('./features/templates/template-list').then((m) => m.TemplateListPage),
        title: 'Plantillas · Hajime',
      },
      {
        path: 'usuarios',
        canActivate: [adminGuard],
        loadComponent: () => import('./features/login/users').then((m) => m.UsersPage),
        title: 'Usuarios · Hajime',
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
