import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, TitleStrategy } from '@angular/router';
import {
  provideMissingTranslationHandler,
  provideTranslateLoader,
  provideTranslateService,
} from '@ngx-translate/core';
import { provideSpartanHlm } from '@ui/utils';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth-interceptor';
import { AuthStore } from './core/auth/auth-store';
import { I18nLoader } from './core/i18n/i18n-loader';
import { LanguageService } from './core/i18n/language';
import { WarnOnMissingTranslation } from './core/i18n/missing-translation';
import { PageTitleStrategy } from './core/page-title/page-title';
import { ThemeService } from './core/theme/theme';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    { provide: TitleStrategy, useExisting: PageTitleStrategy },
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideSpartanHlm(),
    provideTranslateService({
      fallbackLang: 'en',
      loader: provideTranslateLoader(I18nLoader),
      missingTranslationHandler: provideMissingTranslationHandler(WarnOnMissingTranslation),
    }),
    // The language's texts before the first page renders: no keys flash on screen.
    provideAppInitializer(() => inject(LanguageService).init()),
    // Know who is signed in before the first route's guards run.
    provideAppInitializer(() => inject(AuthStore).load()),
    // Light or dark on every page (login included), following the device until the user chooses.
    provideAppInitializer(() => void inject(ThemeService)),
  ],
};
