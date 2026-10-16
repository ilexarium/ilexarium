import type { Routes } from '@angular/router';
import { authGuard, guestGuard, setupGuard } from './core/auth/auth-guards';

export const routes: Routes = [
  {
    path: 'setup',
    title: 'pages.setup',
    canActivate: [setupGuard],
    loadComponent: () => import('./features/auth/setup-page/setup-page').then((m) => m.SetupPage),
  },
  {
    path: 'login',
    title: 'pages.login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login-page/login-page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell/shell').then((m) => m.Shell),
    children: [
      {
        path: '',
        title: 'pages.dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard-page/dashboard-page').then((m) => m.DashboardPage),
      },
      {
        path: 'containers',
        title: 'pages.containers',
        loadComponent: () =>
          import('./features/containers/containers-page/containers-page').then(
            (m) => m.ContainersPage,
          ),
      },
      {
        path: 'containers/:name/logs',
        title: 'pages.logs',
        loadComponent: () =>
          import('./features/containers/logs-page/logs-page').then((m) => m.LogsPage),
      },
      {
        path: 'services',
        title: 'pages.services',
        loadComponent: () =>
          import('./features/services/services-page/services-page').then((m) => m.ServicesPage),
      },
      {
        path: 'services/install/:id',
        title: 'pages.installService',
        loadComponent: () =>
          import('./features/services/install-page/install-page').then((m) => m.InstallPage),
      },
      {
        path: 'backups',
        title: 'pages.backups',
        loadComponent: () =>
          import('./features/backups/backups-page/backups-page').then((m) => m.BackupsPage),
      },
      {
        path: 'disks',
        title: 'pages.disks',
        loadComponent: () =>
          import('./features/disks/disks-page/disks-page').then((m) => m.DisksPage),
      },
      {
        path: 'settings/account',
        title: 'pages.account',
        loadComponent: () =>
          import('./features/settings/account-page/account-page').then((m) => m.AccountPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
