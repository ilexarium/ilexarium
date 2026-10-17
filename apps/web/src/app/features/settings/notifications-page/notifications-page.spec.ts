import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AlertChannelsResponse } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AlertsApi } from '../../../core/alerts/alerts-api';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { NotificationsPage } from './notifications-page';

const SAVED: AlertChannelsResponse = {
  email: {
    enabled: true,
    host: 'mail.example.com',
    port: 587,
    username: 'alerts',
    passwordSet: true,
    from: 'homelab@example.com',
    to: 'me@example.com',
    lastFailure: { channel: 'email', at: '2026-10-17T12:02:00.000Z', problem: 'loginRefused' },
  },
  ntfy: { enabled: true, topicSet: true, tokenSet: true, lastFailure: null },
};

async function render(channels: AlertChannelsResponse) {
  const auth = fakeAuthApi({ user: OWNER });
  const api = {
    channels: vi.fn(async () => channels),
    updateEmail: vi.fn(async () => undefined),
    updateNtfy: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ sent: true, problem: null })),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), auth.provider, { provide: AlertsApi, useValue: api }],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(NotificationsPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const card = (id: string) => el.querySelector<HTMLElement>(`section[aria-labelledby="${id}"]`)!;
  const type = async (id: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const click = async (root: HTMLElement, text: string) => {
    [...root.querySelectorAll('button')].find((b) => b.textContent!.trim() === text)!.click();
    await fixture.whenStable();
  };
  return { fixture, el, api, card, type, click };
}

describe('NotificationsPage', () => {
  it('shows the saved settings; secrets only as saved', async () => {
    const { el, card } = await render(SAVED);
    expect(el.querySelector<HTMLInputElement>('#email-host')!.value).toBe('mail.example.com');
    expect(el.querySelector<HTMLInputElement>('#email-password')!.value).toBe('');
    expect(card('email-title').textContent).toContain('A password is saved');
    expect(card('ntfy-title').textContent).toContain('A topic is saved');
    expect(card('ntfy-title').textContent).toContain('A token is saved');
    expect(card('email-title').textContent).toContain('The server refused the login.');
  });

  it('saves the mail settings, keeping the password when left empty', async () => {
    const { api, card, type, click } = await render(SAVED);
    await type('email-to', 'other@example.com');
    await click(card('email-title'), 'Save');
    expect(api.updateEmail).toHaveBeenCalledWith({
      enabled: true,
      host: 'mail.example.com',
      port: 587,
      username: 'alerts',
      from: 'homelab@example.com',
      to: 'other@example.com',
    });
  });

  it('puts the server’s refusal on its field', async () => {
    const { el, api, card, type, click } = await render(SAVED);
    api.updateEmail.mockRejectedValue(
      new HttpErrorResponse({
        status: 400,
        error: {
          message: 'Validation failed',
          code: 'address_refused',
          errors: [{ field: 'host', code: 'address_refused', message: 'never' }],
        },
      }),
    );
    await type('email-host', '169.254.169.254');
    await click(card('email-title'), 'Save');
    expect(el.querySelector('#email-host')!.closest('[hlmField]')!.textContent).toContain(
      'The app never sends to this address',
    );
  });

  it('checks the fields before sending', async () => {
    const { el, api, card, type, click } = await render(SAVED);
    await type('email-to', 'not an address');
    await click(card('email-title'), 'Save');
    expect(api.updateEmail).not.toHaveBeenCalled();
    expect(el.querySelector('#email-to')!.closest('[hlmField]')!.textContent).toContain(
      'An email address',
    );
  });

  it('saves ntfy: a new topic, and removing the token', async () => {
    const { el, api, card, type, click } = await render(SAVED);
    await type('ntfy-topic', 'http://192.168.1.20/homelab-alerts');
    expect(card('ntfy-title').textContent).toContain(
      'Plain http:// works only on your own network',
    );
    const clear = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) =>
      c.closest('label')!.textContent!.includes('Remove the saved token'),
    )!;
    clear.click();
    await click(card('ntfy-title'), 'Save');
    expect(api.updateNtfy).toHaveBeenCalledWith({
      enabled: true,
      topicUrl: 'http://192.168.1.20/homelab-alerts',
      token: null,
    });
  });

  it('suggests a long random topic name', async () => {
    const { el } = await render({ email: null, ntfy: null });
    const placeholder = el.querySelector<HTMLInputElement>('#ntfy-topic')!.placeholder;
    expect(placeholder).toMatch(/^https:\/\/ntfy\.sh\/homelab-[a-z2-9]{12}$/);
  });

  it('sends a test and says how it went; not before the settings are saved', async () => {
    const { api, card, click } = await render({ ...SAVED, email: null });
    const testButton = (id: string) =>
      [...card(id).querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent!.includes('Send a test'),
      )!;
    expect(testButton('email-title').disabled).toBe(true);
    const success = vi.spyOn(toast, 'success');
    await click(card('ntfy-title'), 'Send a test');
    expect(api.test).toHaveBeenCalledWith('ntfy');
    expect(success).toHaveBeenCalledWith('Test message sent');

    api.test.mockResolvedValue({ sent: false, problem: 'unreachable' } as never);
    const error = vi.spyOn(toast, 'error');
    await click(card('ntfy-title'), 'Send a test');
    expect(error).toHaveBeenCalledWith("The test message couldn't be sent", {
      description: "The server couldn't be reached.",
    });
  });
});
