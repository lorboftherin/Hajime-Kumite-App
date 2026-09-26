import { inject } from '@angular/core';
import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/auth.guard';
import { AuthService } from './core/auth.service';
import { homePath } from './core/roles';
import { mesaPendingGuard } from './features/mesa/mesa-pending.guard';
import { Shell } from './layout/shell';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/login/login').then((m) => m.LoginPage), title: () => $localize`:@@rutas.ingresar-hajime:Ingresar · Hajime` },
  {
    // Obligatoria si la contraseña la asignó el Admin (must_change_password); también desde el menú.
    path: 'cambiar-clave',
    canActivate: [authGuard],
    loadComponent: () => import('./features/login/change-password').then((m) => m.ChangePasswordPage),
    title: () => $localize`:@@rutas.cambiar-contrasena-hajime:Cambiar contraseña · Hajime`,
  },
  {
    path: 'mi-cuenta',
    canActivate: [authGuard],
    loadComponent: () => import('./features/login/delete-account').then((m) => m.DeleteAccountPage),
    title: () => $localize`:@@rutas.borrar-mi-cuenta-hajime:Borrar mi cuenta · Hajime`,
  },
  // --- Cuentas sin sesión (docs/cuentas-y-correo.md) ---
  {
    path: 'recuperar-clave',
    loadComponent: () => import('./features/cuenta/forgot-password').then((m) => m.ForgotPasswordPage),
    title: () => $localize`:@@rutas.recuperar-contrasena-hajime:Recuperar contraseña · Hajime`,
  },
  {
    // El enlace del correo lleva el token en el fragmento: /restablecer-clave#<token>.
    path: 'restablecer-clave',
    loadComponent: () => import('./features/cuenta/reset-password').then((m) => m.ResetPasswordPage),
    title: () => $localize`:@@rutas.contrasena-nueva-hajime:Contraseña nueva · Hajime`,
  },
  {
    path: 'verificar-correo',
    loadComponent: () => import('./features/cuenta/verify-email').then((m) => m.VerifyEmailPage),
    title: () => $localize`:@@rutas.confirmar-correo-hajime:Confirmar correo · Hajime`,
  },
  {
    path: 'crear-cuenta',
    loadComponent: () => import('./features/cuenta/signup').then((m) => m.SignupPage),
    title: () => $localize`:@@rutas.crear-cuenta-hajime:Crear cuenta · Hajime`,
  },
  {
    // Avisos push de este dispositivo: con o sin cuenta (docs/avisos-push.md).
    path: 'avisos',
    loadComponent: () => import('./features/cuenta/push-settings').then((m) => m.PushSettingsPage),
    title: () => $localize`:@@rutas.avisos-hajime:Avisos · Hajime`,
  },
  {
    path: 'privacidad',
    loadComponent: () => import('./features/cuenta/privacy').then((m) => m.PrivacyPage),
    title: () => $localize`:@@rutas.privacidad-hajime:Privacidad · Hajime`,
  },
  {
    // Perfil público básico del competidor (sin inicio de sesión).
    path: 'competidor/:publicId',
    loadComponent: () => import('./features/competidor/public-profile').then((m) => m.PublicProfilePage),
    title: () => $localize`:@@rutas.competidor-hajime:Competidor · Hajime`,
  },
  // --- Portal público (sin inicio de sesión; solo con el público activo). Ver docs/portal-publico.md ---
  {
    // Seguimiento en vivo por el enlace secreto.
    path: 'vivo/:token',
    loadComponent: () => import('./features/public/live').then((m) => m.PublicLivePage),
    title: () => $localize`:@@rutas.vivo-hajime:En vivo · Hajime`,
  },
  {
    path: 'vivo/:token/categoria/:id',
    loadComponent: () => import('./features/public/category').then((m) => m.PublicCategoryPage),
    title: () => $localize`:@@rutas.llave-hajime-vivo:Llave · Hajime en vivo`,
  },
  {
    // Página pública por la dirección fija del torneo: lo mismo que /vivo/:token.
    path: 't/:slug',
    loadComponent: () => import('./features/public/live').then((m) => m.PublicLivePage),
    title: () => $localize`:@@rutas.vivo-hajime:En vivo · Hajime`,
  },
  {
    path: 't/:slug/categoria/:id',
    loadComponent: () => import('./features/public/category').then((m) => m.PublicCategoryPage),
    title: () => $localize`:@@rutas.llave-hajime-vivo:Llave · Hajime en vivo`,
  },
  {
    path: 'torneos-publicos',
    loadComponent: () => import('./features/public/directory').then((m) => m.PublicDirectoryPage),
    title: () => $localize`:@@rutas.torneos-karate-vivo-hajime:Torneos de karate en vivo · Hajime`,
  },
  {
    // Pantalla grande del coliseo: todos los tatamis en mosaico o uno a pantalla completa.
    path: 'pantalla/:token',
    loadComponent: () => import('./features/public/screen').then((m) => m.ScreenMosaicPage),
    title: () => $localize`:@@rutas.pantalla-hajime:Pantalla · Hajime`,
  },
  {
    path: 'pantalla/:token/:tatami',
    loadComponent: () => import('./features/public/screen').then((m) => m.ScreenPage),
    title: () => $localize`:@@rutas.pantalla-hajime:Pantalla · Hajime`,
  },
  {
    // Ranking público de una temporada marcada pública (sin inicio de sesión).
    path: 'ranking/:temporada',
    loadComponent: () => import('./features/ranking/public-ranking').then((m) => m.PublicRankingPage),
    title: () => $localize`:@@rutas.ranking-hajime:Ranking · Hajime`,
  },
  {
    // Overlay para transmisiones (OBS/vMix): fondo transparente.
    path: 'overlay/:token/:tatami',
    loadComponent: () => import('./features/public/overlay').then((m) => m.OverlayPage),
    title: () => $localize`:@@rutas.overlay-hajime:Overlay · Hajime`,
  },
  {
    // Mesa de kumite: pantalla completa, sin navegación.
    path: 'mesa/:matchId',
    canActivate: [authGuard],
    canDeactivate: [mesaPendingGuard],
    loadComponent: () => import('./features/mesa/mesa').then((m) => m.MesaPage),
    title: () => $localize`:@@rutas.mesa-hajime:Mesa · Hajime`,
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
        title: () => $localize`:@@rutas.mis-perfiles-hajime:Mis perfiles · Hajime`,
      },
      {
        path: 'perfil',
        loadComponent: () => import('./features/cuenta/account').then((m) => m.AccountPage),
        title: () => $localize`:@@rutas.mi-cuenta-hajime:Mi cuenta · Hajime`,
      },
      {
        path: 'solicitudes',
        loadComponent: () => import('./features/cuenta/claims-review').then((m) => m.ClaimsReviewPage),
        title: () => $localize`:@@rutas.solicitudes-perfil-hajime:Solicitudes de perfil · Hajime`,
      },
      {
        path: 'mi-tatami',
        loadComponent: () => import('./features/mesa/my-tatami').then((m) => m.MyTatamiPage),
        title: () => $localize`:@@rutas.mi-tatami-hajime:Mi tatami · Hajime`,
      },
      {
        path: 'torneos',
        loadComponent: () => import('./features/tournaments/tournament-list').then((m) => m.TournamentListPage),
        title: () => $localize`:@@rutas.torneos-hajime:Torneos · Hajime`,
      },
      {
        // Credenciales imprimibles con QR (antes de 'torneos/:id', que tiene pestañas hijas).
        path: 'torneos/:id/credenciales',
        loadComponent: () => import('./features/checkin/credentials-page').then((m) => m.CredentialsPage),
        title: () => $localize`:@@rutas.credenciales-hajime:Credenciales · Hajime`,
      },
      {
        path: 'ranking',
        loadComponent: () => import('./features/ranking/ranking-page').then((m) => m.RankingPage),
        title: () => $localize`:@@rutas.ranking-hajime:Ranking · Hajime`,
      },
      {
        path: 'torneos/:id',
        loadComponent: () => import('./features/tournaments/tournament-detail').then((m) => m.TournamentDetailPage),
        loadChildren: () => import('./features/tournaments/tournament.routes').then((m) => m.TOURNAMENT_TABS),
      },
      {
        path: 'categorias/:id/llave',
        loadComponent: () => import('./features/bracket/bracket-page').then((m) => m.BracketPage),
        title: () => $localize`:@@rutas.llave-hajime:Llave · Hajime`,
      },
      {
        path: 'combates/:id',
        loadComponent: () => import('./features/matches/match-summary').then((m) => m.MatchSummaryPage),
        title: () => $localize`:@@rutas.combate-hajime:Combate · Hajime`,
      },
      {
        path: 'personas',
        loadComponent: () => import('./features/persons/person-list').then((m) => m.PersonListPage),
        title: () => $localize`:@@rutas.personas-hajime:Personas · Hajime`,
      },
      {
        path: 'personas/:id',
        loadComponent: () => import('./features/persons/person-detail').then((m) => m.PersonDetailPage),
        title: () => $localize`:@@rutas.persona-hajime:Persona · Hajime`,
      },
      {
        path: 'dojos',
        loadComponent: () => import('./features/dojos/dojo-list').then((m) => m.DojoListPage),
        title: () => $localize`:@@rutas.dojos-hajime:Dojos · Hajime`,
      },
      {
        path: 'dojos/:id',
        loadComponent: () => import('./features/dojos/dojo-detail').then((m) => m.DojoDetailPage),
        title: () => $localize`:@@rutas.dojo-hajime:Dojo · Hajime`,
      },
      {
        path: 'plantillas',
        loadComponent: () => import('./features/templates/template-list').then((m) => m.TemplateListPage),
        title: () => $localize`:@@rutas.plantillas-hajime:Plantillas · Hajime`,
      },
      {
        path: 'organizacion',
        loadComponent: () => import('./features/organizations/organization-page').then((m) => m.OrganizationPage),
        title: () => $localize`:@@rutas.organizacion-hajime:Organización · Hajime`,
      },
      {
        path: 'organizacion/:id',
        loadComponent: () => import('./features/organizations/organization-page').then((m) => m.OrganizationPage),
        title: () => $localize`:@@rutas.organizacion-hajime:Organización · Hajime`,
      },
      {
        path: 'planes',
        loadComponent: () => import('./features/organizations/plans-page').then((m) => m.PlansPage),
        title: () => $localize`:@@rutas.planes-hajime:Planes · Hajime`,
      },
      {
        // Pago con Culqi Checkout (el script de Culqi se carga solo en esta página).
        path: 'pago/culqi/:id',
        loadComponent: () => import('./features/billing/culqi-page').then((m) => m.CulqiPage),
        title: () => $localize`:@@rutas.pago-hajime:Pago · Hajime`,
      },
      ...(['exito', 'pendiente', 'error'] as const).map((result) => ({
        // Retorno de la pasarela (Mercado Pago vuelve a estas URL).
        path: `pago/${result}`,
        data: { result },
        loadComponent: () => import('./features/billing/payment-result').then((m) => m.PaymentResultPage),
        title: () => $localize`:@@rutas.pago-hajime:Pago · Hajime`,
      })),
      {
        path: 'pagos',
        canActivate: [adminGuard],
        loadComponent: () => import('./features/billing/payments-admin').then((m) => m.PaymentsAdminPage),
        title: () => $localize`:@@rutas.pagos-hajime:Pagos · Hajime`,
      },
      {
        path: 'mis-competidores',
        loadComponent: () => import('./features/dojo-portal/dojo-portal').then((m) => m.DojoPortalPage),
        title: () => $localize`:@@rutas.mis-competidores-hajime:Mis competidores · Hajime`,
      },
      {
        // Enlace de invitación a la autoinscripción de un torneo.
        path: 'invitacion/:token',
        loadComponent: () => import('./features/dojo-portal/invitation').then((m) => m.InvitationPage),
        title: () => $localize`:@@rutas.invitacion-hajime:Invitación · Hajime`,
      },
      {
        path: 'usuarios',
        canActivate: [adminGuard],
        loadComponent: () => import('./features/login/users').then((m) => m.UsersPage),
        title: () => $localize`:@@rutas.usuarios-hajime:Usuarios · Hajime`,
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
