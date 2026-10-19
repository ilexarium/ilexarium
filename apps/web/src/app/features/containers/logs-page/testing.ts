import { EVENT_SOURCE_FACTORY } from './logs-page-store';

/** An `EventSource` the test drives: `emit()` an event, `fail()` the connection. */
export class FakeEventSource {
  readyState = 0;
  closed = false;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** A server event; `id` becomes `lastEventId`. */
  emit(type: string, data: unknown, id = ''): void {
    this.readyState = 1;
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The connection dropped: `reconnecting` like the browser does, or given up (`CLOSED`). */
  fail({ reconnecting }: { reconnecting: boolean }): void {
    this.readyState = reconnecting ? 0 : 2;
    this.onerror?.();
  }

  /** The query of the URL it was opened with. */
  get query(): Record<string, string> {
    return Object.fromEntries(new URL(this.url, 'http://x').searchParams);
  }
}

/** Provides an `EventSource` factory that records every source the app opens. */
export function fakeEventSources() {
  const sources: FakeEventSource[] = [];
  return {
    sources,
    latest: () => sources.at(-1)!,
    provider: {
      provide: EVENT_SOURCE_FACTORY,
      useValue: (url: string) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    },
  };
}
