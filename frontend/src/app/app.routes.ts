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
  // --- Cuentas sin sesión (docs/cuentas-y-correo.md) ---
  {
    path: 'recuperar-clave',
    loadComponent: () => import('./features/cuenta/forgot-password').then((m) => m.ForgotPasswordPage),
    title: 'Recuperar contraseña · Hajime',
  },
  {
    // El enlace del correo lleva el token en el fragmento: /restablecer-clave#<token>.
    path: 'restablecer-clave',
    loadComponent: () => import('./features/cuenta/reset-password').then((m) => m.ResetPasswordPage),
    title: 'Contraseña nueva · Hajime',
  },
  {
    path: 'verificar-correo',
    loadComponent: () => import('./features/cuenta/verify-email').then((m) => m.VerifyEmailPage),
    title: 'Confirmar correo · Hajime',
  },
  {
    path: 'crear-cuenta',
    loadComponent: () => import('./features/cuenta/signup').then((m) => m.SignupPage),
    title: 'Crear cuenta · Hajime',
  },
  {
    path: 'privacidad',
    loadComponent: () => import('./features/cuenta/privacy').then((m) => m.PrivacyPage),
    title: 'Privacidad · Hajime',
  },
  {
    // Perfil público básico del competidor (sin inicio de sesión).
    path: 'competidor/:publicId',
    loadComponent: () => import('./features/competidor/public-profile').then((m) => m.PublicProfilePage),
    title: 'Competidor · Hajime',
  },
  // --- Portal público (sin inicio de sesión; solo con el público activo). Ver docs/portal-publico.md ---
  {
    // Seguimiento en vivo por el enlace secreto.
    path: 'vivo/:token',
    loadComponent: () => import('./features/public/live').then((m) => m.PublicLivePage),
    title: 'En vivo · Hajime',
  },
  {
    path: 'vivo/:token/categoria/:id',
    loadComponent: () => import('./features/public/category').then((m) => m.PublicCategoryPage),
    title: 'Llave · Hajime en vivo',
  },
  {
    // Página pública por la dirección fija del torneo: lo mismo que /vivo/:token.
    path: 't/:slug',
    loadComponent: () => import('./features/public/live').then((m) => m.PublicLivePage),
    title: 'En vivo · Hajime',
  },
  {
    path: 't/:slug/categoria/:id',
    loadComponent: () => import('./features/public/category').then((m) => m.PublicCategoryPage),
    title: 'Llave · Hajime en vivo',
  },
  {
    path: 'torneos-publicos',
    loadComponent: () => import('./features/public/directory').then((m) => m.PublicDirectoryPage),
    title: 'Torneos de karate en vivo · Hajime',
  },
  {
    // Pantalla grande del coliseo: todos los tatamis en mosaico o uno a pantalla completa.
    path: 'pantalla/:token',
    loadComponent: () => import('./features/public/screen').then((m) => m.ScreenMosaicPage),
    title: 'Pantalla · Hajime',
  },
  {
    path: 'pantalla/:token/:tatami',
    loadComponent: () => import('./features/public/screen').then((m) => m.ScreenPage),
    title: 'Pantalla · Hajime',
  },
  {
    // Ranking público de una temporada marcada pública (sin inicio de sesión).
    path: 'ranking/:temporada',
    loadComponent: () => import('./features/ranking/public-ranking').then((m) => m.PublicRankingPage),
    title: 'Ranking · Hajime',
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
        path: 'mis-perfiles',
        loadComponent: () => import('./features/cuenta/my-profiles').then((m) => m.MyProfilesPage),
        title: 'Mis perfiles · Hajime',
      },
      {
        path: 'perfil',
        loadComponent: () => import('./features/cuenta/account').then((m) => m.AccountPage),
        title: 'Mi cuenta · Hajime',
      },
      {
        path: 'solicitudes',
        loadComponent: () => import('./features/cuenta/claims-review').then((m) => m.ClaimsReviewPage),
        title: 'Solicitudes de perfil · Hajime',
      },
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
        // Credenciales imprimibles con QR (antes de 'torneos/:id', que tiene pestañas hijas).
        path: 'torneos/:id/credenciales',
        loadComponent: () => import('./features/checkin/credentials-page').then((m) => m.CredentialsPage),
        title: 'Credenciales · Hajime',
      },
      {
        path: 'ranking',
        loadComponent: () => import('./features/ranking/ranking-page').then((m) => m.RankingPage),
        title: 'Ranking · Hajime',
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
