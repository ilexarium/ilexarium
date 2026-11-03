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
        path: 'apps',
        title: 'pages.apps',
        loadComponent: () => import('./features/apps/apps-page/apps-page').then((m) => m.AppsPage),
      },
      {
        path: 'apps/new',
        title: 'pages.newApp',
        loadComponent: () =>
          import('./features/apps/new-app-page/new-app-page').then((m) => m.NewAppPage),
      },
      {
        path: 'apps/:name',
        title: 'pages.app',
        loadComponent: () => import('./features/apps/app-page/app-page').then((m) => m.AppPage),
      },
      { path: 'services', redirectTo: 'apps' },
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
        path: 'alerts',
        title: 'pages.alerts',
        loadComponent: () =>
          import('./features/alerts/alerts-page/alerts-page').then((m) => m.AlertsPage),
      },
      {
        path: 'system/processes',
        title: 'pages.processes',
        loadComponent: () =>
          import('./features/system/processes-page/processes-page').then((m) => m.ProcessesPage),
      },
      {
        path: 'system/services',
        title: 'pages.services',
        loadComponent: () =>
          import('./features/system/services-page/services-page').then((m) => m.ServicesPage),
      },
      {
        path: 'system/logs',
        title: 'pages.journal',
        loadComponent: () =>
          import('./features/system/journal-page/journal-page').then((m) => m.JournalPage),
      },
      {
        path: 'system/files',
        title: 'pages.files',
        loadComponent: () =>
          import('./features/system/files-page/files-page').then((m) => m.FilesPage),
      },
      {
        path: 'system/terminal',
        title: 'pages.terminal',
        loadComponent: () =>
          import('./features/system/terminal-page/terminal-page').then((m) => m.TerminalPage),
      },
      {
        path: 'settings/notifications',
        title: 'pages.notifications',
        loadComponent: () =>
          import('./features/settings/notifications-page/notifications-page').then(
            (m) => m.NotificationsPage,
          ),
      },
      {
        path: 'profile',
        title: 'pages.profile',
        loadComponent: () =>
          import('./features/profile/profile-page/profile-page').then((m) => m.ProfilePage),
      },
      // The password is changed in a dialog on the profile page now (2026-10-20).
      { path: 'settings/account', redirectTo: 'profile' },
    ],
  },
  { path: '**', redirectTo: '' },
];
