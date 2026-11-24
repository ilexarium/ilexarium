import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideRouter, TitleStrategy } from '@angular/router';
import {
  MissingTranslationHandler,
  provideTranslateService,
  TranslateLoader,
} from '@ngx-translate/core';
import { provideSpartanHlm } from '@ui/utils';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth-interceptor';
import { strictQueryInterceptor } from './core/http/strict-query';
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
    // XHR, not Fetch: Fetch can't report an upload's progress (the uploads panel shows it).
    provideHttpClient(withXhr(), withInterceptors([strictQueryInterceptor, authInterceptor])),
    provideSpartanHlm(),
    provideTranslateService({
      fallbackLang: 'en',
      // Plain providers, not provideTranslateLoader(I18nLoader): that helper tells a class from a
      // factory by its source text starting with "class " — minified, it's "class{", so the
      // production build called the class as a function and the app never started.
      loader: { provide: TranslateLoader, useClass: I18nLoader },
      missingTranslationHandler: {
        provide: MissingTranslationHandler,
        useClass: WarnOnMissingTranslation,
      },
    }),
    // The language's texts before the first page renders: no keys flash on screen.
    provideAppInitializer(() => inject(LanguageService).init()),
    // Know who is signed in before the first route's guards run.
    provideAppInitializer(() => inject(AuthStore).load()),
    // Light or dark on every page (login included), following the device until the user chooses.
    provideAppInitializer(() => void inject(ThemeService)),
  ],
};
