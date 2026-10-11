import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, Router, TitleStrategy } from '@angular/router';
import { PageTitleStrategy } from './page-title';

describe('PageTitleStrategy', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', title: 'Dashboard', children: [] },
          { path: 'untitled', children: [] },
        ]),
        { provide: TitleStrategy, useExisting: PageTitleStrategy },
      ],
    });
  });

  it("uses the route's title for the page and the browser tab", async () => {
    await TestBed.inject(Router).navigateByUrl('/');
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('Dashboard');
    expect(TestBed.inject(Title).getTitle()).toBe('Dashboard · Homelab');
  });

  it('falls back to the app name for a route without a title', async () => {
    await TestBed.inject(Router).navigateByUrl('/untitled');
    expect(TestBed.inject(PageTitleStrategy).pageTitle()).toBe('');
    expect(TestBed.inject(Title).getTitle()).toBe('Homelab');
  });
});
