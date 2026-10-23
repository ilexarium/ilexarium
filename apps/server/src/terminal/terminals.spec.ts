import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { WsAuthenticator } from '@nestjs/authentication';
import { WebSocket } from 'ws';
import type { AuditService } from '../audit/audit.service.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { TerminalTickets } from './terminal-tickets.js';
import { SESSION_RECHECK_MS } from './terminal.constants.js';
import { Terminals } from './terminals.js';

/** A socket and a shell channel with just what the terminal uses. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  paused = false;
  sent: { data: Buffer; done: () => void }[] = [];
  closedWith: number | null = null;
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  send(data: Buffer, _options: unknown, done: () => void) {
    this.sent.push({ data, done });
  }
  close(code: number) {
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
  }
}
class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  paused = false;
  written: Buffer[] = [];
  writable = true;
  window: number[] = [];
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  write(data: Buffer) {
    this.written.push(data);
    return this.writable;
  }
  setWindow(rows: number, cols: number) {
    this.window = [rows, cols];
  }
  close() {}
}

async function setup() {
  const socket = new FakeSocket();
  const channel = new FakeChannel();
  let closeSession: (why: string) => void = () => undefined;
  const linux = {
    shell: vi.fn(async () => ({
      channel,
      username: 'anna',
      onSessionClose: (listener: (why: string) => void) => {
        closeSession = listener;
        return () => undefined;
      },
    })),
    touch: vi.fn(),
  };
  const tickets = new TerminalTickets();
  const wsAuth = {
    authenticateConnection: vi.fn(async () => ({
      session: { id: 's1' },
      user: { id: 'u1', username: 'owner' },
    })),
  };
  const audit = { tryRecord: vi.fn(async () => undefined) };
  const terminals = new Terminals(
    wsAuth as unknown as WsAuthenticator,
    linux as unknown as LinuxSessions,
    tickets,
    audit as unknown as AuditService,
  );
  const request = {
    url: `/api/terminal?ticket=${tickets.issue('s1')}&cols=80&rows=24`,
    headers: { origin: 'https://box', host: 'box' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
  await terminals.open(socket as unknown as WebSocket, request);
  return {
    socket,
    channel,
    linux,
    audit,
    wsAuth,
    closeSession: (why: string) => closeSession(why),
  };
}

describe('Terminals', () => {
  afterEach(() => vi.useRealTimers());

  it('closes (4401) when the re-check finds no session, another one, or only a user', async () => {
    vi.useFakeTimers();
    for (const answer of [
      null,
      { session: { id: 's2' }, user: { id: 'u1' } },
      { user: { id: 'u1' } },
    ]) {
      const { socket, wsAuth } = await setup();
      wsAuth.authenticateConnection.mockResolvedValue(answer as never);
      await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
      expect(socket.closedWith).toBe(4401);
    }
  });

  it('keeps it open while the re-check finds its session, and never runs two re-checks at once', async () => {
    vi.useFakeTimers();
    const { socket, wsAuth } = await setup();
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
    expect(socket.closedWith).toBeNull();
    const calls = wsAuth.authenticateConnection.mock.calls.length;
    wsAuth.authenticateConnection.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS * 3);
    expect(wsAuth.authenticateConnection.mock.calls.length).toBe(calls + 1);
  });

  it('holds input until the shell is there, then passes keystrokes on (counting as use)', async () => {
    const { socket, channel, linux } = await setup();
    expect(linux.shell).toHaveBeenCalledWith('s1', { cols: 80, rows: 24 });
    expect(socket.paused).toBe(false);
    socket.emit('message', Buffer.from('ls\n'), true);
    expect(channel.written.map(String)).toEqual(['ls\n']);
    expect(linux.touch).toHaveBeenCalledWith('s1');
  });

  it('resizes on a control message; anything else closes it (1008)', async () => {
    const { socket, channel } = await setup();
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })),
      false,
    );
    expect(channel.window).toEqual([40, 120]);
    socket.emit('message', Buffer.from('{"type":"resize","cols":9999,"rows":1}'), false);
    expect(socket.closedWith).toBe(1008);
  });

  it('a slow browser pauses the shell; it resumes once the browser caught up', async () => {
    const { socket, channel } = await setup();
    socket.bufferedAmount = 2 * 1024 * 1024;
    channel.emit('data', Buffer.from('lots'));
    expect(channel.paused).toBe(true);
    socket.bufferedAmount = 100;
    socket.sent[0].done();
    expect(channel.paused).toBe(false);
  });

  it('a slow shell pauses the socket until it drains', async () => {
    const { socket, channel } = await setup();
    channel.writable = false;
    socket.emit('message', Buffer.from('a big paste'), true);
    expect(socket.paused).toBe(true);
    channel.emit('drain');
    expect(socket.paused).toBe(false);
  });

  it('closes with the Linux session: 4401 at the app’s sign-out, 4003 otherwise; audited', async () => {
    const one = await setup();
    one.closeSession('app-sign-out');
    expect(one.socket.closedWith).toBe(4401);
    const two = await setup();
    two.closeSession('idle');
    expect(two.socket.closedWith).toBe(4003);
    expect(two.audit.tryRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'terminal.close',
        details: { linuxUser: 'anna', reason: 'linux-idle' },
      }),
    );
  });

  it('the shell’s exit closes it (4000)', async () => {
    const { socket, channel } = await setup();
    channel.emit('close');
    expect(socket.closedWith).toBe(4000);
  });
});
