import { inject, Service, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { type RouterStateSnapshot, TitleStrategy } from '@angular/router';

export const APP_NAME = 'Homelab';

/**
 * Page titles come from each route's `title`: shown in the top bar (`pageTitle`) and as the
 * browser tab title ("Dashboard · Homelab").
 */
@Service()
export class PageTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly current = signal('');

  /** The current route's title, '' when it has none. */
  readonly pageTitle = this.current.asReadonly();

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const pageTitle = this.buildTitle(snapshot) ?? '';
    this.current.set(pageTitle);
    this.title.setTitle(pageTitle ? `${pageTitle} · ${APP_NAME}` : APP_NAME);
  }
}
