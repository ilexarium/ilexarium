import { isDevMode } from '@angular/core';
import type {
  MissingTranslationHandler,
  MissingTranslationHandlerParams,
} from '@ngx-translate/core';

/** Shows the key (better than nothing); in development, also says so in the console. */
export class WarnOnMissingTranslation implements MissingTranslationHandler {
  handle({ key }: MissingTranslationHandlerParams): string {
    if (isDevMode()) console.warn(`Missing translation: ${key}`);
    return key;
  }
}
