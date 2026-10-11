import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, TitleStrategy } from '@angular/router';
import { provideSpartanHlm } from '@ui/utils';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth-interceptor';
import { AuthStore } from './core/auth/auth-store';
import { PageTitleStrategy } from './core/page-title/page-title';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    { provide: TitleStrategy, useExisting: PageTitleStrategy },
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideSpartanHlm(),
    // Know who is signed in before the first route's guards run.
    provideAppInitializer(() => inject(AuthStore).load()),
  ],
};
