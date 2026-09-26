import { inject } from '@angular/core';
import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/auth.guard';
import { AuthService } from './core/auth.service';
import { homePath } from './core/roles';
import { mesaPendingGuard } from './features/mesa/mesa-pending.guard';
import { Shell } from './layout/shell';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/login/login').then((m) => m.LoginPage), title: 'Ingresar · Hajime' },
  {
    // Obligatoria si la contraseña la asignó el Admin (must_change_password); también desde el menú.
    path: 'cambiar-clave',
    canActivate: [authGuard],
    loadComponent: () => import('./features/login/change-password').then((m) => m.ChangePasswordPage),
    title: 'Cambiar contraseña · Hajime',
  },
  {
    path: 'mi-cuenta',
    canActivate: [authGuard],
    loadComponent: () => import('./features/login/delete-account').then((m) => m.DeleteAccountPage),
    title: 'Borrar mi cuenta · Hajime',
  },
  {
    // Seguimiento en vivo público (sin inicio de sesión; solo con enlace activo).
    path: 'vivo/:token',
    loadComponent: () => import('./features/public/live').then((m) => m.PublicLivePage),
    title: 'En vivo · Hajime',
  },
  {
    // Overlay para transmisiones (OBS/vMix): fondo transparente.
    path: 'overlay/:token/:tatami',
    loadComponent: () => import('./features/public/overlay').then((m) => m.OverlayPage),
    title: 'Overlay · Hajime',
  },
  {
    // Mesa de kumite: pantalla completa, sin navegación.
    path: 'mesa/:matchId',
    canActivate: [authGuard],
    canDeactivate: [mesaPendingGuard],
    loadComponent: () => import('./features/mesa/mesa').then((m) => m.MesaPage),
    title: 'Mesa · Hajime',
  },
  {
    path: '',
    component: Shell,
    canActivate: [authGuard],
    children: [
      // El operador de un tatami entra a «Mi tatami»; los demás, a la lista de torneos.
      { path: '', pathMatch: 'full', redirectTo: () => homePath(inject(AuthService).user()) },
      {
        path: 'mi-tatami',
        loadComponent: () => import('./features/mesa/my-tatami').then((m) => m.MyTatamiPage),
        title: 'Mi tatami · Hajime',
      },
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
        path: 'combates/:id',
        loadComponent: () => import('./features/matches/match-summary').then((m) => m.MatchSummaryPage),
        title: 'Combate · Hajime',
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
        path: 'dojos/:id',
        loadComponent: () => import('./features/dojos/dojo-detail').then((m) => m.DojoDetailPage),
        title: 'Dojo · Hajime',
      },
      {
        path: 'plantillas',
        loadComponent: () => import('./features/templates/template-list').then((m) => m.TemplateListPage),
        title: 'Plantillas · Hajime',
      },
      {
        path: 'organizacion',
        loadComponent: () => import('./features/organizations/organization-page').then((m) => m.OrganizationPage),
        title: 'Organización · Hajime',
      },
      {
        path: 'organizacion/:id',
        loadComponent: () => import('./features/organizations/organization-page').then((m) => m.OrganizationPage),
        title: 'Organización · Hajime',
      },
      {
        path: 'planes',
        loadComponent: () => import('./features/organizations/plans-page').then((m) => m.PlansPage),
        title: 'Planes · Hajime',
      },
      {
        path: 'mis-competidores',
        loadComponent: () => import('./features/dojo-portal/dojo-portal').then((m) => m.DojoPortalPage),
        title: 'Mis competidores · Hajime',
      },
      {
        // Enlace de invitación a la autoinscripción de un torneo.
        path: 'invitacion/:token',
        loadComponent: () => import('./features/dojo-portal/invitation').then((m) => m.InvitationPage),
        title: 'Invitación · Hajime',
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
