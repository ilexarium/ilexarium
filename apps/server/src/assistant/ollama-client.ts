import { Ollama } from 'ollama';
import { z } from 'zod';
import { OLLAMA_IDLE_MS, OLLAMA_REQUEST_MS } from './assistant.constants.js';
import type { OllamaMessage, OllamaPullLine } from './assistant.model.js';

/** Ollama answered with an error, or not at all. `status` 0: no answer. */
export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const versionSchema = z.object({ version: z.string() });
const tagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      modified_at: z.union([z.string(), z.date()]).transform(String),
      details: z
        .object({
          family: z.string().optional(),
          parameter_size: z.string().optional(),
          quantization_level: z.string().optional(),
        })
        .partial()
        .optional(),
    }),
  ),
});
const psSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
const chatPartSchema = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean().optional(),
});
const pullPartSchema = z.object({
  status: z.string().optional(),
  digest: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
});

export type OllamaTags = z.infer<typeof tagsSchema>;

/**
 * Ollama's API (docs/plans/ai_assistant.md) through its official client (`ollama`), at one fixed
 * loopback address — the installed recipe's port, never an address from a request. Around the
 * library: every request goes through `guardedFetch` (no redirects; quick calls time out), streams
 * give up after `OLLAMA_IDLE_MS` without a part and stop with
 * our signal, and every answer is checked.
 */
export class OllamaClient {
  private readonly ollama: Ollama;

  constructor(baseUrl: string) {
    this.ollama = new Ollama({ host: baseUrl, fetch: guardedFetch });
  }

  async version(): Promise<string> {
    return versionSchema.parse(await call(() => this.ollama.version())).version;
  }

  async tags(): Promise<OllamaTags> {
    return tagsSchema.parse(await call(() => this.ollama.list()));
  }

  /** The models loaded in memory. */
  async loaded(): Promise<Set<string>> {
    const { models } = psSchema.parse(await call(() => this.ollama.ps()));
    return new Set(models.map((model) => model.name));
  }

  async remove(model: string): Promise<void> {
    await call(() => this.ollama.delete({ model }));
  }

  /** Downloads a model; each progress part as it comes. Stopping (the signal) cancels it in Ollama. */
  async *pull(model: string, signal: AbortSignal): AsyncGenerator<OllamaPullLine> {
    const stream = await call(() => this.ollama.pull({ model, stream: true }));
    for await (const part of guarded(stream, signal)) yield pullPartSchema.parse(part);
  }

  /** An answer, piece by piece. A stream that breaks off before it's done is an error. */
  async *chat(
    model: string,
    messages: OllamaMessage[],
    contextTokens: number,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const stream = await call(() =>
      this.ollama.chat({ model, messages, stream: true, options: { num_ctx: contextTokens } }),
    );
    for await (const part of guarded(stream, signal)) {
      const { message } = chatPartSchema.parse(part);
      if (message?.content) yield message.content;
    }
  }
}

/** One of the library's calls, its failures as `OllamaError`s. */
async function call<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw asOllamaError(error);
  }
}

/** The library's errors: `ResponseError` (Ollama said no; not exported), a failed fetch, a stream's error line. */
function asOllamaError(error: unknown): unknown {
  if (error instanceof OllamaError || isAbort(error)) return error;
  if (error instanceof Error && error.name === 'ResponseError') {
    const status = (error as Error & { status_code?: number }).status_code ?? 0;
    return new OllamaError(error.message, status);
  }
  if (error instanceof TypeError) return new OllamaError('Ollama is not reachable', 0);
  return new OllamaError(error instanceof Error ? error.message : 'Ollama failed', 200);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * A library stream, stopped by `signal` and given up after `OLLAMA_IDLE_MS` without a part
 * (a stalled model must not hold a person's answer slot); its errors as `OllamaError`s.
 */
async function* guarded<T>(
  stream: AsyncIterable<T> & { abort(): void },
  signal: AbortSignal,
): AsyncGenerator<T> {
  let idle = false;
  let timer = setTimeout(stopIdle, OLLAMA_IDLE_MS);
  function stopIdle(): void {
    idle = true;
    stream.abort();
  }
  const stop = () => stream.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stream.abort();
  try {
    for await (const part of stream) {
      clearTimeout(timer);
      timer = setTimeout(stopIdle, OLLAMA_IDLE_MS);
      yield part;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (idle) throw new OllamaError('No answer in time', 0);
    throw asOllamaError(error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

/** The library's `fetch`: never follows a redirect; a quick call (no signal of its own) times out after `OLLAMA_REQUEST_MS`. */
function guardedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(OLLAMA_REQUEST_MS),
  });
}
