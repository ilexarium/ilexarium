import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { AuthStore } from './core/auth/auth-store';
import { fakeAuthApi, OWNER } from './core/auth/testing';

async function render(server: Parameters<typeof fakeAuthApi>[0]) {
  const fake = fakeAuthApi(server);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [provideRouter([{ path: '**', children: [] }]), fake.provider],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(App);
  await fixture.whenStable();
  return { fixture, ...fake, text: () => (fixture.nativeElement as HTMLElement).textContent };
}

describe('App', () => {
  it('shows "Can\'t reach the server" with Retry when the server is down', async () => {
    const { text } = await render({ down: true });
    expect(text()).toContain("Can't reach the server");
    expect(text()).toContain('Retry');
  });

  it('Retry asks again and re-runs the current navigation', async () => {
    const { fixture, server, api, text } = await render({ down: true });
    server.down = false;
    server.user = OWNER;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    (fixture.nativeElement as HTMLElement).querySelector('button')!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    await fixture.whenStable();
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("Can't reach the server");
  });

  it('renders the routed page once the server answered', async () => {
    const { text } = await render({ user: null });
    expect(text()).not.toContain("Can't reach the server");
    expect(text()).not.toContain('Loading');
  });
});
