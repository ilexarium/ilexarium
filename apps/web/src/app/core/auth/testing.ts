import type { PublicUser } from '@laris/shared';
import { AuthApi } from './auth-api';
import { SIGN_OUT_CHANNEL } from './sign-out-channel';

export const OWNER: PublicUser = {
  id: '0192f3a1-7c2e-7a4b-9d1e-3f5a7c9b2d4e',
  username: 'owner',
  createdAt: '2026-10-11T00:00:00.000Z',
  displayName: null,
  email: null,
  language: null,
  avatar: null,
};

/** A fake AuthApi whose server answers are set per test. */
export function fakeAuthApi(
  server: { needsSetup?: boolean; user?: PublicUser | null; down?: boolean } = {},
) {
  const fail = () => Promise.reject(new Error('network error'));
  const api = {
    status: vi.fn(() =>
      server.down ? fail() : Promise.resolve({ needsSetup: !!server.needsSetup }),
    ),
    me: vi.fn(() => (server.down ? fail() : Promise.resolve({ user: server.user ?? null }))),
    logout: vi.fn(() => Promise.resolve(null)),
    login: vi.fn(),
    setup: vi.fn(),
    changePassword: vi.fn(),
    logoutEverywhere: vi.fn(() => Promise.resolve(null)),
  };
  return { api, provider: { provide: AuthApi, useValue: api }, server };
}

/** A fake of the other tabs: `receive()` is a message from one of them. */
export function fakeSignOutChannel() {
  const listeners: (() => void)[] = [];
  const channel = {
    postMessage: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((_type: 'message', listener: () => void) => listeners.push(listener)),
  };
  return {
    channel,
    receive: () => listeners.forEach((listener) => listener()),
    provider: { provide: SIGN_OUT_CHANNEL, useValue: channel },
  };
}
