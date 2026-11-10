import type { IncomingMessage } from 'node:http';
import type { AuthenticationEvents, SessionService, WsAuthenticator } from '@nestjs/authentication';
import { WS_CLOSE_CODES } from '@ilex/shared';
import { Subject } from 'rxjs';
import type { WebSocket } from 'ws';
import { RealtimeConnections } from './realtime-connections.js';
import { DEFAULT_REALTIME_OPTIONS, POLICY_VIOLATION } from './realtime.constants.js';

const HOST = 'ilex.test';
const request = (origin = `https://${HOST}`) =>
  ({ headers: { origin, host: HOST } }) as unknown as IncomingMessage;

function socket() {
  const client = {
    readyState: 1,
    closedWith: null as number | null,
    close(code: number) {
      client.readyState = 3;
      client.closedWith = code;
    },
  };
  return client;
}
type FakeSocket = ReturnType<typeof socket>;

/** Who each socket's session belongs to; a socket missing here has no session. */
const sessions = new Map<FakeSocket, { session: { id: string }; user: { id: string } } | null>();
/** The live sessions in the store: session id → user id. */
const live = new Map<string, string>();

function setUp(options = DEFAULT_REALTIME_OPTIONS) {
  const events = new Subject<Record<string, unknown>>();
  const authenticateConnection = vi.fn(async (client: FakeSocket) => sessions.get(client) ?? null);
  const authenticator = { authenticateConnection } as unknown as WsAuthenticator;
  const list = vi.fn(async (userId: string) =>
    [...live].filter(([, owner]) => owner === userId).map(([id]) => ({ id, userId })),
  );
  const connections = new RealtimeConnections(
    authenticator,
    { list } as unknown as SessionService,
    { events$: events.asObservable() } as unknown as AuthenticationEvents,
    options,
  );
  connections.onModuleInit();
  current = connections;
  const open = async (sessionId: string | null, userId = 'u1', origin?: string) => {
    const client = socket();
    sessions.set(client, sessionId ? { session: { id: sessionId }, user: { id: userId } } : null);
    if (sessionId) live.set(sessionId, userId);
    const connection = await connections.admit(client as unknown as WebSocket, request(origin));
    return { client, connection };
  };
  return { connections, events, open, authenticateConnection, list };
}

let current: RealtimeConnections | null = null;

describe('RealtimeConnections', () => {
  afterEach(() => {
    current?.onModuleDestroy();
    current = null;
    sessions.clear();
    live.clear();
    vi.useRealTimers();
  });

  it('refuses another site (1008) and a socket without a session (4401)', async () => {
    const { open } = setUp();
    const foreign = await open('s1', 'u1', 'https://evil.example');
    expect(foreign.connection).toBeNull();
    expect(foreign.client.closedWith).toBe(POLICY_VIOLATION);
    const anonymous = await open(null);
    expect(anonymous.connection).toBeNull();
    expect(anonymous.client.closedWith).toBe(WS_CLOSE_CODES.sessionEnded);
  });

  it('admits a handful of sockets per session, and one more once one is released', async () => {
    const { connections, open } = setUp();
    const admitted = [];
    for (let i = 0; i < DEFAULT_REALTIME_OPTIONS.maxConnectionsPerSession; i++) {
      admitted.push(await open('s1'));
    }
    expect(admitted.every((a) => a.connection !== null)).toBe(true);
    const tooMany = await open('s1');
    expect(tooMany.client.closedWith).toBe(POLICY_VIOLATION);
    expect((await open('s2')).connection).not.toBeNull(); // another session: its own count

    connections.release(admitted[0].client as unknown as WebSocket);
    expect((await open('s1')).connection).not.toBeNull();
  });

  it('answers `admitted` only once the admission is done', async () => {
    const { connections, open } = setUp();
    const { client } = await open('s1');
    expect(await connections.admitted(client as unknown as WebSocket)).toMatchObject({
      sessionId: 's1',
    });
    connections.release(client as unknown as WebSocket);
    expect(await connections.admitted(client as unknown as WebSocket)).toBeNull();
  });

  it('closes the signed-out session’s sockets, or all of a user’s for "everywhere"', async () => {
    const { events, open } = setUp();
    const a = await open('s1', 'u1');
    const b = await open('s2', 'u1');
    const other = await open('s3', 'u2');

    events.next({ type: 'sign-out', userId: 'u1', sessionId: 's1' });
    expect(a.client.closedWith).toBe(WS_CLOSE_CODES.sessionEnded);
    expect(b.client.closedWith).toBeNull();

    events.next({ type: 'sign-out', userId: 'u1', everywhere: true });
    expect(b.client.closedWith).toBe(WS_CLOSE_CODES.sessionEnded);
    expect(other.client.closedWith).toBeNull();
  });

  it('closes a socket whose session ended at the next re-check, with one timer for all', async () => {
    vi.useFakeTimers();
    const { connections, open } = setUp();
    const ended = await open('s1');
    const kept = await open('s2');
    live.delete('s1');

    await vi.advanceTimersByTimeAsync(DEFAULT_REALTIME_OPTIONS.sessionRecheckMs);
    expect(ended.client.closedWith).toBe(WS_CLOSE_CODES.sessionEnded);
    expect(kept.client.closedWith).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    connections.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-checks by listing each user’s live sessions once, never validating (no activity)', async () => {
    vi.useFakeTimers();
    const { open, authenticateConnection, list } = setUp();
    await open('s1', 'u1');
    await open('s1', 'u1');
    await open('s2', 'u2');
    const admissions = authenticateConnection.mock.calls.length;

    await vi.advanceTimersByTimeAsync(DEFAULT_REALTIME_OPTIONS.sessionRecheckMs);
    expect(authenticateConnection.mock.calls.length).toBe(admissions);
    expect(list.mock.calls.map(([userId]) => userId).sort()).toEqual(['u1', 'u2']);
  });

  it('skips a re-check while the previous one is still going', async () => {
    vi.useFakeTimers();
    const { open, list } = setUp();
    await open('s1');
    let finish = () => {};
    list.mockImplementation(() => new Promise((resolve) => (finish = () => resolve([]))));
    await vi.advanceTimersByTimeAsync(DEFAULT_REALTIME_OPTIONS.sessionRecheckMs * 3);
    expect(list).toHaveBeenCalledTimes(1);
    finish();
  });
});
