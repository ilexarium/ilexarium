import { HttpErrorResponse } from '@angular/common/http';
import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LinuxSession } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { WEB_SOCKET_FACTORY } from '../../../core/realtime/realtime-service';
import { TerminalApi } from '../../../core/terminal/terminal-api';
import { stubScreenWidth } from '../../../layout/testing';
import { TerminalView } from '../terminal-view/terminal-view';
import type { TerminalSize } from '../terminal.model';
import { TerminalPage } from './terminal-page';

const ANNA: LinuxSession = { username: 'anna', home: '/home/anna' };
const signInDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const submit = () =>
  signInDialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

/** xterm needs a canvas jsdom lacks: a stand-in with the same inputs and outputs. */
@Component({ selector: 'laris-terminal-view', template: '<div data-terminal></div>' })
class FakeTerminalView {
  static last: FakeTerminalView | null = null;
  readonly dark = input(false);
  readonly ready = output<TerminalSize>();
  readonly resized = output<TerminalSize>();
  readonly data = output<string>();
  written = '';
  constructor() {
    FakeTerminalView.last = this;
    queueMicrotask(() => this.ready.emit({ cols: 80, rows: 24 }));
  }
  write(bytes: Uint8Array): void {
    this.written += new TextDecoder().decode(bytes);
  }
}

class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  output(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer as ArrayBuffer });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

async function render(session: LinuxSession | null = ANNA, sessionCheckFails = false) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets: FakeSocket[] = [];
  const files = {
    session: vi.fn(() =>
      sessionCheckFails
        ? throwError(() => new HttpErrorResponse({ status: 503 }))
        : of({ session }),
    ),
    signIn: vi.fn(() => of(ANNA)),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      auth.provider,
      { provide: FilesApi, useValue: files },
      {
        provide: WEB_SOCKET_FACTORY,
        useValue: (url: string) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      },
    ],
  });
  TestBed.overrideComponent(TerminalPage, {
    remove: { imports: [TerminalView] },
    add: { imports: [FakeTerminalView] },
  });
  const ticket = vi.spyOn(TestBed.inject(TerminalApi), 'ticket');
  ticket.mockReturnValue(of({ ticket: 'tkt' }));
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(TerminalPage);
  await fixture.whenStable();
  await vi.waitFor(() => expect(files.session).toHaveBeenCalled());
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent!.includes(text),
    );
  const unlock = async (password = 'app password') => {
    const input = signInDialog()!.querySelector<HTMLInputElement>('#terminal-password')!;
    input.value = password;
    input.dispatchEvent(new Event('input'));
    submit();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await fixture.whenStable();
    return sockets[0];
  };
  return { fixture, el, files, ticket, sockets, unlock, button };
}

describe('TerminalPage', () => {
  let restoreScreen: () => void;
  beforeEach(() => (restoreScreen = stubScreenWidth(1440)));
  afterEach(() => {
    restoreScreen();
    document.querySelectorAll('.cdk-overlay-container').forEach((e) => e.remove());
  });

  it('says so when checking for a Linux session fails, and asks for the Linux account', async () => {
    const error = vi.spyOn(toast, 'error');
    await render(null, true);
    expect(error).toHaveBeenCalled();
    expect(signInDialog()!.querySelector('input[autocomplete="username"]')).not.toBeNull();
    expect(signInDialog()!.querySelector('#terminal-password')).toBeNull();
    error.mockRestore();
  });

  it('without a Linux session: the dialog opens on its own — the sign-in, then the app password', async () => {
    const { files, fixture } = await render(null);
    expect(signInDialog()!.textContent).toContain('Open a terminal');
    const [username, password] = signInDialog()!.querySelectorAll<HTMLInputElement>('input');
    username.value = 'anna';
    username.dispatchEvent(new Event('input'));
    password.value = 'linux';
    password.dispatchEvent(new Event('input'));
    submit();
    await vi.waitFor(() => expect(files.signIn).toHaveBeenCalled());
    await fixture.whenStable();
    expect(signInDialog()!.textContent).toContain('Confirm it’s you');
  });

  it('with a Linux session: the dialog starts at the app password', async () => {
    await render();
    expect(signInDialog()!.textContent).toContain('Confirm it’s you');
    expect(signInDialog()!.querySelector('#linux-username')).toBeNull();
  });

  it('cancelled: the page offers to open it, as whom, and the button opens the dialog again', async () => {
    const { el, fixture, button } = await render();
    [...signInDialog()!.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('Cancel'))!
      .click();
    await vi.waitFor(() => expect(signInDialog()).toBeNull());
    await fixture.whenStable();
    expect(el.textContent).toContain('As anna');
    button('Open terminal')!.click();
    await fixture.whenStable();
    expect(signInDialog()!.textContent).toContain('Confirm it’s you');
  });

  it('asks for the app password, then opens the terminal’s socket with the ticket and size', async () => {
    const { ticket, unlock, fixture, el } = await render();
    const socket = await unlock();
    expect(ticket).toHaveBeenCalledWith('app password');
    expect(socket.url).toBe(
      'ws://localhost:3000/api/terminal?ticket=tkt&cols=80&rows=24'.replace(
        'localhost:3000',
        location.host,
      ),
    );
    expect(socket.binaryType).toBe('arraybuffer');
    socket.open();
    await fixture.whenStable();
    expect(el.textContent).toContain('anna');

    socket.output('anna@box:~$ ');
    expect(FakeTerminalView.last!.written).toBe('anna@box:~$ ');
    FakeTerminalView.last!.data.emit('ls\n');
    expect(new TextDecoder().decode(socket.sent[0] as Uint8Array)).toBe('ls\n');
    FakeTerminalView.last!.resized.emit({ cols: 100, rows: 30 });
    expect(socket.sent[1]).toBe('{"type":"resize","cols":100,"rows":30}');
  });

  it('a wrong app password shows on the field; no socket', async () => {
    const { el, ticket, sockets, fixture } = await render();
    ticket.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: {
              message: 'Validation failed',
              errors: [{ field: 'password', code: 'wrong_password', message: 'x' }],
            },
          }),
      ),
    );
    const input = signInDialog()!.querySelector<HTMLInputElement>('#terminal-password')!;
    input.value = 'nope';
    input.dispatchEvent(new Event('input'));
    submit();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(signInDialog()!.querySelector('hlm-field-error')?.textContent).toBeTruthy();
    });
    expect(sockets).toHaveLength(0);
  });

  it.each([
    [4000, 'The shell ended.'],
    [4009, 'took its place'],
    [1006, 'The connection was lost.'],
  ])('closed (%i): says why, and opening again asks for the password', async (code, text) => {
    const { unlock, fixture, el, button } = await render();
    const socket = await unlock();
    socket.open();
    socket.serverClose(code);
    await fixture.whenStable();
    expect(el.textContent).toContain(text);
    expect(signInDialog()).toBeNull();
    button('Open again')!.click();
    await fixture.whenStable();
    expect(signInDialog()!.textContent).toContain('Confirm it’s you');
  });

  it('the Linux session ended (4003): back to the Linux sign-in, saying why', async () => {
    const { unlock, fixture, el } = await render();
    const socket = await unlock();
    socket.open();
    socket.serverClose(4003);
    await fixture.whenStable();
    expect(el.textContent).toContain('The Linux session ended');
    expect(el.textContent).toContain('Open a terminal');
    expect(signInDialog()).toBeNull();
  });

  it('the app session ended (4401): signed out', async () => {
    const { unlock } = await render();
    const expired = vi.spyOn(TestBed.inject(AuthStore), 'sessionExpired');
    const socket = await unlock();
    socket.open();
    socket.serverClose(4401);
    expect(expired).toHaveBeenCalled();
  });

  it('closing it says so', async () => {
    const { unlock, fixture, el, button } = await render();
    const socket = await unlock();
    socket.open();
    await fixture.whenStable();
    button('Close terminal')!.click();
    await fixture.whenStable();
    expect(el.textContent).toContain('You closed it.');
  });

  it('leaving the page closes the socket', async () => {
    const { unlock, fixture } = await render();
    const socket = await unlock();
    socket.open();
    fixture.destroy();
    expect(socket.readyState).toBe(3);
  });
});
