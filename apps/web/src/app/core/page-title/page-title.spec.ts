import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, TitleStrategy } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { PageTitleStrategy } from './page-title';

describe('PageTitleStrategy', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', title: 'pages.dashboard', children: [] },
          { path: 'containers/:name/logs', title: 'pages.logs', children: [] },
          { path: 'untitled', children: [] },
        ]),
        { provide: TitleStrategy, useExisting: PageTitleStrategy },
      ],
    });
  });

  it("translates the route's title for the page and the browser tab", async () => {
    await TestBed.inject(Router).navigateByUrl('/');
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Dashboard');
    expect(TestBed.inject(Title).getTitle()).toBe('Dashboard · Laris');
  });

  it("fills in the route's parameters", async () => {
    await TestBed.inject(Router).navigateByUrl('/containers/jellyfin/logs');
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Logs · jellyfin');
    expect(TestBed.inject(Title).getTitle()).toBe('Logs · jellyfin · Laris');
  });

  it('follows a language switch', async () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('xx', { pages: { dashboard: 'Übersicht' } });
    await TestBed.inject(Router).navigateByUrl('/');
    translate.use('xx');
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Übersicht');
    expect(TestBed.inject(Title).getTitle()).toBe('Übersicht · Laris');
  });

  it('falls back to the app name for a route without a title', async () => {
    await TestBed.inject(Router).navigateByUrl('/untitled');
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('');
    expect(TestBed.inject(Title).getTitle()).toBe('Laris');
  });
});
