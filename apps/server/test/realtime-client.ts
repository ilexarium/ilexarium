import { type ServerMessage, serverMessageSchema } from '@homelab/shared';
import type { WebSocket } from 'ws';

/** A test client: everything received, and how it closed. */
export class Client {
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: (() => void)[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      // Every message the server sends must match the shared protocol.
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw.toString())));
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) =>
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  get events(): string[] {
    return this.messages.map((message) => message.event);
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Resolves once `count` messages have arrived in total; each wait times out after `timeoutMs`. */
  async received(count: number, timeoutMs = 2000): Promise<ServerMessage[]> {
    while (this.messages.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out at ${this.messages.length}/${count} messages`)),
          timeoutMs,
        );
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages;
  }

  /** A round trip: by the time an `error` reply arrives, everything sent before was handled. */
  async flush(): Promise<void> {
    const count = this.messages.length;
    this.send({ event: 'subscribe', data: { topic: 'nope' } });
    await this.received(count + 1);
    this.messages.pop();
  }
}
