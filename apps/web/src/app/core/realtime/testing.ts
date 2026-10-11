import { WEB_SOCKET_FACTORY } from './realtime-service';

/** A WebSocket the test drives: `open()`, `receive()`, `serverClose()`; records what was sent. */
export class FakeSocket {
  readyState = 0;
  readonly sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  /** Closed by the app; like a real socket, the close event follows. */
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Provides a socket factory that records every socket the app opens. */
export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    latest: () => sockets.at(-1)!,
    provider: {
      provide: WEB_SOCKET_FACTORY,
      useValue: (url: string) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    },
  };
}
