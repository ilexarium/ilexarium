import { computed, inject, Service, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { merge } from 'rxjs';

export const APP_NAME = 'Ilexarium';

/**
 * Page titles come from each route's `title`, a translation key (`pages.containers`), filled in
 * with the route's parameters (`pages.logs`: "Logs · {{name}}"). Shown in the top bar
 * (`pageTitle`) and as the browser tab title ("Containers · Ilexarium"); both follow a language
 * switch.
 */
@Service()
export class PageTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly translateService = inject(TranslateService);
  private readonly current = signal<{ key: string; params: Record<string, string> } | null>(null);
  /** Changes when the language or its translations do. */
  private readonly revision = toSignal(
    merge(this.translateService.onLangChange, this.translateService.onTranslationChange),
  );

  /** The current route's title, '' when it has none. */
  readonly pageTitle = computed(() => {
    this.revision();
    const current = this.current();
    return current ? (this.translateService.instant(current.key, current.params) as string) : '';
  });

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const key = this.buildTitle(snapshot);
    this.current.set(key ? { key, params: routeParams(snapshot) } : null);
    this.setDocumentTitle();
  }

  constructor() {
    super();
    this.translateService.onLangChange.subscribe(() => this.setDocumentTitle());
  }

  private setDocumentTitle(): void {
    const pageTitle = this.pageTitle();
    this.title.setTitle(pageTitle ? `${pageTitle} · ${APP_NAME}` : APP_NAME);
  }
}

/** Every parameter along the active route, e.g. `{ name: 'jellyfin' }`. */
function routeParams(snapshot: RouterStateSnapshot): Record<string, string> {
  const params: Record<string, string> = {};
  for (let route = snapshot.root; route; route = route.firstChild!) {
    Object.assign(params, route.params);
    if (!route.firstChild) break;
  }
  return params;
}
