import { inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { FILES_ERROR_CODES, type LinuxSignInRequest, TERMINAL_CLOSE_CODES } from '@laris/shared';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { TerminalApi } from '../../../core/terminal/terminal-api';
import { apiErrorCode } from '../../../shared/forms/submission-errors';
import type { TerminalClosedReason, TerminalPhase, TerminalSize } from '../terminal.model';
import { CLOSE_REASONS, OPEN } from './terminal-page.constants';

interface TerminalPageState {
  phase: TerminalPhase;
  /** The ticket got with the app password, until the terminal knows its size and connects. */
  ticket: string | null;
  closedReason: TerminalClosedReason | null;
}

const initialState: TerminalPageState = {
  phase: 'locked',
  ticket: null,
  closedReason: null,
};

/**
 * The Terminal page's data, provided by the page and gone with it (docs/plans/
 * files_and_terminal.md, step 2): the Linux session (`LinuxSessionStore`, shared), the app
 * password again (a one-time ticket), then the terminal's own socket — keystrokes out, the shell's output to the page's `sink` (bytes
 * for the terminal view: a stream, not state). Closed with the page.
 */
export const TerminalPageStore = signalStore(
  withState<TerminalPageState>(initialState),
  withComputed((_, linuxSessionStore = inject(LinuxSessionStore)) => ({
    checked: linuxSessionStore.checked,
    session: linuxSessionStore.session,
  })),
  withMethods(
    (
      store,
      terminalApi = inject(TerminalApi),
      authStore = inject(AuthStore),
      linuxSessionStore = inject(LinuxSessionStore),
    ) => {
      let socket: WebSocket | null = null;
      const encoder = new TextEncoder();

      const closed = (code: number) => {
        socket = null;
        if (code === TERMINAL_CLOSE_CODES.sessionEnded) {
          authStore.sessionExpired();
          return;
        }
        const reason = CLOSE_REASONS[code] ?? (code === 1000 ? 'closed' : 'lost');
        patchState(store, { phase: 'closed', closedReason: reason });
        // Without a Linux session, the sign-in comes back.
        if (reason === 'linuxSessionEnded') linuxSessionStore.ended();
      };

      return {
        /** Rejects with the server's error (the form shows it). */
        async signIn(request: LinuxSignInRequest): Promise<void> {
          await linuxSessionStore.signIn(request);
          patchState(store, { phase: 'locked', closedReason: null });
        },

        /**
         * The app password again; rejects with the server's error (the form shows it). A Linux
         * session that ended meanwhile: back to the Linux sign-in, saying why.
         */
        async unlock(password: string): Promise<void> {
          const { ticket } = await firstValueFrom(terminalApi.ticket(password)).catch(
            (error: unknown) => {
              if (apiErrorCode(error) === FILES_ERROR_CODES.linuxSessionRequired) {
                linuxSessionStore.ended();
                patchState(store, { phase: 'locked', closedReason: 'linuxSessionEnded' });
              }
              throw error;
            },
          );
          patchState(store, { ticket, phase: 'connecting', closedReason: null });
        },

        /** Connects once the terminal view knows its size; output goes to `sink`. */
        connect(size: TerminalSize, sink: (bytes: Uint8Array) => void): void {
          const ticket = store.ticket();
          if (!ticket || socket) return;
          patchState(store, { ticket: null });
          const opened = terminalApi.open(ticket, size);
          socket = opened;
          opened.onopen = () => patchState(store, { phase: 'open' });
          opened.onmessage = (event: MessageEvent<ArrayBuffer | string>) =>
            sink(
              typeof event.data === 'string'
                ? encoder.encode(event.data)
                : new Uint8Array(event.data),
            );
          opened.onclose = (event: CloseEvent) => {
            if (socket === opened) closed(event.code);
          };
        },

        /** Keystrokes (and the phone key bar's keys). */
        send(data: string): void {
          if (socket?.readyState === OPEN) socket.send(encoder.encode(data));
        },

        resize(size: TerminalSize): void {
          if (socket?.readyState === OPEN) socket.send(JSON.stringify({ type: 'resize', ...size }));
        },

        close(): void {
          socket?.close(1000);
        },

        /** The page goes away: the shell ends with it. */
        disconnect(): void {
          const open = socket;
          socket = null;
          open?.close(1000);
        },
      };
    },
  ),
  withHooks((store, linuxSessionStore = inject(LinuxSessionStore)) => ({
    onInit() {
      linuxSessionStore.check();
    },
    onDestroy() {
      store.disconnect();
    },
  })),
);
