import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A model as the fake lists it. */
export interface FakeModel {
  name: string;
  size: number;
}

/**
 * A stand-in for Ollama on a free loopback port (the unit and e2e tests): the endpoints the
 * Assistant uses, answers set by each test, every request recorded.
 */
export class FakeOllama {
  models: FakeModel[] = [{ name: 'smollm2:135m', size: 270_898_672 }];
  loaded: string[] = [];
  /** The answer, in pieces; `hang` keeps the stream open after them. */
  answer: { pieces: string[]; error?: string; hang?: boolean; delayMs?: number } = {
    pieces: ['Hello', ' there', '!'],
  };
  /** Download progress lines, then success (or an error line). */
  pull: { lines: object[]; error?: string; hang?: boolean } = {
    lines: [
      { status: 'pulling manifest' },
      { status: 'pulling a', digest: 'sha256:a', total: 1000, completed: 0 },
      { status: 'pulling a', digest: 'sha256:a', total: 1000, completed: 1000 },
    ],
  };
  readonly requests: { method: string; url: string; body: any }[] = [];
  /** Requests still streaming, by path, that the client has closed. */
  readonly closed: string[] = [];
  private server: Server | null = null;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get port(): number {
    return (this.server!.address() as AddressInfo).port;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => (data += chunk.toString()));
      req.on('end', () => {
        const body = data ? JSON.parse(data) : null;
        this.requests.push({ method: req.method!, url: req.url!, body });
        void this.handle(req, res, body);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, body: any): Promise<void> {
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    switch (`${req.method} ${req.url}`) {
      case 'GET /api/version':
        return json(200, { version: '0.40.6' });
      case 'GET /api/tags':
        return json(200, {
          models: this.models.map((model) => ({
            name: model.name,
            model: model.name,
            size: model.size,
            modified_at: '2026-10-19T12:57:13.171482009Z',
            details: { family: 'llama', parameter_size: '134.52M', quantization_level: 'F16' },
          })),
        });
      case 'GET /api/ps':
        return json(200, { models: this.loaded.map((name) => ({ name })) });
      case 'DELETE /api/delete': {
        const index = this.models.findIndex((model) => model.name === body.model);
        if (index < 0) return json(404, { error: `model '${body.model}' not found` });
        this.models.splice(index, 1);
        return json(200, {});
      }
      case 'POST /api/pull':
        return this.stream(
          res,
          req.url!,
          [
            ...this.pull.lines,
            this.pull.error
              ? { error: this.pull.error }
              : this.pull.hang
                ? null
                : { status: 'success' },
          ],
          this.pull.hang,
        );
      case 'POST /api/chat': {
        if (!this.models.some((model) => model.name === body.model)) {
          return json(404, { error: `model '${body.model}' not found` });
        }
        const lines: (object | null)[] = this.answer.pieces.map((content) => ({
          message: { role: 'assistant', content },
          done: false,
        }));
        if (this.answer.error) lines.push({ error: this.answer.error });
        else if (!this.answer.hang)
          lines.push({ message: { role: 'assistant', content: '' }, done: true });
        return this.stream(res, req.url!, lines, this.answer.hang, this.answer.delayMs);
      }
      default:
        return json(404, { error: 'not found' });
    }
  }

  private async stream(
    res: ServerResponse,
    path: string,
    lines: (object | null)[],
    hang = false,
    delayMs = 0,
  ): Promise<void> {
    res.on('close', () => {
      if (!res.writableFinished) this.closed.push(path);
    });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const line of lines) {
      if (line === null) continue;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (res.destroyed) return;
      res.write(`${JSON.stringify(line)}\n`);
    }
    if (!hang) res.end();
  }
}
