import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  LinuxSession,
  SystemService,
  SystemServiceDetails,
  SystemServicesResponse,
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { SystemServicesApi } from '../../../core/system-services/system-services-api';
import { SignInPrompt } from '../../../layout/sign-in-prompt/sign-in-prompt';
import { SudoDialog } from '../../../layout/sudo-dialog/sudo-dialog';
import { stubScreenWidth } from '../../../layout/testing';
import { ServicesPage } from './services-page';

const unit = (name: string, change: Partial<SystemService> = {}): SystemService => ({
  name,
  description: `${name} description`,
  load: 'loaded',
  active: 'active',
  sub: 'running',
  enabled: 'enabled',
  protection: null,
  ...change,
});

const NGINX = unit('nginx.service', { description: 'A web server' });
const VPN = unit('vpn.service', { active: 'failed', sub: 'failed' });
const SYNC = unit('sync.service', { active: 'inactive', sub: 'dead', enabled: 'disabled' });
const ILEX = unit('ilex.service', { protection: 'ilex' });
const SSH = unit('ssh.service', { protection: 'essential' });

const DETAILS: SystemServiceDetails = {
  ...NGINX,
  since: '2026-11-03T10:00:00.000Z',
  mainPid: 452,
  memoryBytes: 16_000_000,
  result: 'success',
  exitStatus: 0,
  restarts: 0,
  unitFile: '/usr/lib/systemd/system/nginx.service',
};

const ANNA: LinuxSession = { username: 'anna', home: '/home/anna', uid: 1000, sudoUntil: null };
const httpError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { message: 'x', code } });
const alertDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const buttonIn = (root: ParentNode | null, text: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) =>
    b.textContent!.includes(text),
  )!;
const fill = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

async function render(
  services: SystemService[] = [NGINX, VPN, SYNC, ILEX, SSH],
  linux: LinuxSession | null = ANNA,
) {
  const auth = fakeAuthApi({ user: OWNER });
  const list: SystemServicesResponse = { services, truncated: false };
  const api = {
    list: vi.fn(() => of(list)),
    details: vi.fn(() => of(DETAILS)),
    act: vi.fn(() => of(undefined)),
  };
  let session = linux;
  const filesApi = {
    session: vi.fn(() => of({ session })),
    signIn: vi.fn(() => of((session = ANNA))),
    unlockSudo: vi.fn(() =>
      of({ ...ANNA, sudoUntil: new Date(Date.now() + 15 * 60_000).toISOString() }),
    ),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      { provide: SystemServicesApi, useValue: api },
      { provide: FilesApi, useValue: filesApi },
    ],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(ServicesPage);
  // The shell's prompts: the Linux sign-in and the sudo password.
  TestBed.createComponent(SignInPrompt);
  TestBed.createComponent(SudoDialog);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  /** The table's services, in order. */
  const names = () =>
    [...el.querySelectorAll('tbody th[scope="row"]')].map((th) =>
      th.querySelector('[dir="ltr"]')!.textContent!.trim(),
    );
  const menu = async (name: string, item: string) => {
    el.querySelector<HTMLButtonElement>(`table button[aria-label="Actions for ${name}"]`)!.click();
    await fixture.whenStable();
    const items = [...document.querySelectorAll<HTMLElement>('[hlmDropdownMenuItem]')];
    const found = items.find((b) => b.textContent!.includes(item));
    found?.click();
    await fixture.whenStable();
    return items.map((b) => b.textContent!.trim());
  };
  return { fixture, el, api, filesApi, names, menu };
}

describe('ServicesPage', () => {
  let restoreScreen: () => void;
  beforeEach(() => (restoreScreen = stubScreenWidth(1440)));
  afterEach(() => {
    restoreScreen();
    vi.useRealTimers();
    document.querySelectorAll('.cdk-overlay-container').forEach((e) => e.remove());
  });

  it('lists the services, failed first, inactive ones hidden until asked for', async () => {
    const { el, names, fixture } = await render();
    expect(names()).toEqual(['vpn.service', 'ilex.service', 'nginx.service', 'ssh.service']);
    expect(el.textContent).toContain('active (running)');
    expect(el.textContent).toContain('failed (failed)');
    const summary = [...el.querySelectorAll('[data-group]')].map((b) =>
      b.textContent!.replace(/\s+/g, ' ').trim(),
    );
    expect(summary).toEqual(['Failed 1', 'Active 3', 'Inactive 1']);

    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(names()).toContain('sync.service');
  });

  it('filters by the summary’s groups and by search', async () => {
    const { el, names, fixture } = await render();
    el.querySelector<HTMLButtonElement>('[data-group="inactive"]')!.click();
    await fixture.whenStable();
    expect(names()).toEqual(['sync.service']);
    expect(el.textContent).toContain('only inactive ones');
    buttonIn(el, 'Show all').click();
    await fixture.whenStable();
    expect(names()).toHaveLength(4);

    fill(el.querySelector<HTMLInputElement>('input[type="search"]')!, 'web server');
    await fixture.whenStable();
    expect(names()).toEqual(['nginx.service']);
  });

  it('protected services: Ilexarium’s own offer nothing, those it needs no stop', async () => {
    const { menu } = await render();
    expect(await menu('ilex.service', '')).toEqual(['Details']);
    expect(await menu('ssh.service', '')).toEqual(['Details', 'Restart']);
    expect(await menu('nginx.service', '')).toEqual(['Details', 'Stop', 'Restart']);
    expect(await menu('vpn.service', '')).toEqual(['Details', 'Start']);
  });

  it('restarting asks first; through sudo — the password asked, then done, the list again', async () => {
    const { api, filesApi, menu, fixture } = await render();
    const success = vi.spyOn(toast, 'success');
    api.act.mockReturnValueOnce(throwError(() => httpError(403, 'sudo_required')));
    await menu('nginx.service', 'Restart');
    expect(alertDialog()!.textContent).toContain('Restart nginx.service?');
    buttonIn(alertDialog(), 'Restart').click();
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Administrator rights'));
    fill(dialog()!.querySelector<HTMLInputElement>('#sudo-password')!, 'right');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(api.act).toHaveBeenCalledTimes(2));
    expect(api.act).toHaveBeenLastCalledWith('nginx.service', 'restart');
    expect(filesApi.unlockSudo).toHaveBeenCalledWith({ password: 'right' });
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('nginx.service restarted'));
    expect(api.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    await fixture.whenStable();
  });

  it('a service Ilexarium needs: the restart says what happens to Ilexarium', async () => {
    const { menu } = await render();
    await menu('ssh.service', 'Restart');
    expect(alertDialog()!.querySelector('[data-essential-warning]')).not.toBeNull();
  });

  it('starting asks nothing; systemd’s refusal comes as a toast', async () => {
    const { api, menu } = await render();
    const error = vi.spyOn(toast, 'error');
    api.act.mockReturnValueOnce(throwError(() => httpError(502, 'service_action_failed')));
    await menu('vpn.service', 'Start');
    expect(alertDialog()).toBeNull();
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('vpn.service wasn’t started', {
        description: 'systemd couldn’t do it. The service’s state and its log say why.',
      }),
    );
  });

  it('opens a service’s details in a sheet', async () => {
    const { el, api, fixture } = await render();
    buttonIn(el.querySelector('table'), 'nginx.service').click();
    await fixture.whenStable();
    expect(api.details).toHaveBeenCalledWith('nginx.service');
    const sheet = document.querySelector<HTMLElement>('[data-service-sheet]')!;
    expect(sheet.textContent).toContain('nginx.service');
    expect(sheet.textContent).toContain('452');
    expect(sheet.textContent).toContain('/usr/lib/systemd/system/nginx.service');
  });

  it('without a Linux session: asks for the sign-in, then reads the list', async () => {
    const { el, api, filesApi, names, fixture } = await render(undefined, null);
    expect(api.list).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Sign in as a Linux user');
    buttonIn(el, 'Sign in').click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const [user, pass] = dialog()!.querySelectorAll<HTMLInputElement>('input');
    fill(user, 'anna');
    fill(pass, 'secret');
    dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => expect(filesApi.signIn).toHaveBeenCalled());
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    await fixture.whenStable();
    expect(names()).toContain('nginx.service');
  });

  it('asks again every 10 s while the page is shown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api } = await render();
    const before = api.list.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(api.list.mock.calls.length).toBe(before + 1);
  });

  it('a refresh that fails keeps the list, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { el, api, names, fixture } = await render();
    api.list.mockReturnValue(throwError(() => httpError(503, 'services_unavailable')));
    vi.advanceTimersByTime(10_000);
    await fixture.whenStable();
    expect(names()).toContain('nginx.service');
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'systemd couldn’t be asked for the services.',
    );
  });

  it('says so when systemd can’t be asked', async () => {
    const auth = fakeAuthApi({ user: OWNER });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        auth.provider,
        {
          provide: SystemServicesApi,
          useValue: { list: () => throwError(() => httpError(503, 'services_unavailable')) },
        },
        { provide: FilesApi, useValue: { session: () => of({ session: ANNA }) } },
      ],
    });
    await TestBed.inject(AuthStore).load();
    const fixture = TestBed.createComponent(ServicesPage);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'systemd couldn’t be asked for the services.',
    );
  });

  it('phones: one card a service, its menu beside it', async () => {
    restoreScreen();
    restoreScreen = stubScreenWidth(375);
    const { el } = await render();
    const cards = el.querySelectorAll('ul > li');
    expect(cards).toHaveLength(4);
    expect(cards[0]!.textContent).toContain('vpn.service');
    expect(cards[0]!.querySelector('button[aria-label="Actions for vpn.service"]')).not.toBeNull();
  });
});
