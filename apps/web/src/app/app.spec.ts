import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { HealthResponse } from '@homelab/shared';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('renders server health from /api/health', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const body: HealthResponse = { status: 'ok', version: '1.2.3', uptimeSeconds: 42 };
    TestBed.inject(HttpTestingController).expectOne('/api/health').flush(body);
    await fixture.whenStable();

    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('ok · v1.2.3 · up 42s');
  });
});
