import { HttpClient, HttpParams, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { strictQueryInterceptor } from './strict-query';

describe('strictQueryInterceptor', () => {
  function setUp() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([strictQueryInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    return { http: TestBed.inject(HttpClient), backend: TestBed.inject(HttpTestingController) };
  }

  it('escapes ; and = in values (a Go proxy drops a pair holding a ;), values unchanged', () => {
    const { http, backend } = setUp();
    const cursor = 's=e799;i=1ad46;b=c523;x=9796';
    http
      .get('/api/system/journal', {
        params: new HttpParams().set('priority', 'info').set('after', cursor),
      })
      .subscribe();
    const request = backend.expectOne(() => true).request;
    expect(request.urlWithParams).toBe(
      `/api/system/journal?priority=info&after=${encodeURIComponent(cursor)}`,
    );
    expect(request.params.get('after')).toBe(cursor);
  });

  it('every value of a key, in order; a plain object of params too', () => {
    const { http, backend } = setUp();
    http.get('/api/files', { params: { path: '/home/anna/a;b', tag: ['x', 'y=z'] } }).subscribe();
    expect(backend.expectOne(() => true).request.urlWithParams).toBe(
      '/api/files?path=%2Fhome%2Fanna%2Fa%3Bb&tag=x&tag=y%3Dz',
    );
  });

  it('leaves a request without a query as it is', () => {
    const { http, backend } = setUp();
    http.get('/api/health').subscribe();
    expect(backend.expectOne(() => true).request.urlWithParams).toBe('/api/health');
  });
});
