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
      modified_at: z.string(),
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
const chatLineSchema = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});

export type OllamaTags = z.infer<typeof tagsSchema>;

/**
 * Ollama's HTTP API (docs/plans/ai_assistant.md) at one fixed loopback address — the installed
 * recipe's port, never an address from a request. Answers are checked; streams are NDJSON.
 */
export class OllamaClient {
  constructor(private readonly baseUrl: string) {}

  async version(): Promise<string> {
    return versionSchema.parse(await this.json('GET', '/api/version')).version;
  }

  async tags(): Promise<OllamaTags> {
    return tagsSchema.parse(await this.json('GET', '/api/tags'));
  }

  /** The models loaded in memory. */
  async loaded(): Promise<Set<string>> {
    const { models } = psSchema.parse(await this.json('GET', '/api/ps'));
    return new Set(models.map((model) => model.name));
  }

  async remove(model: string): Promise<void> {
    await this.json('DELETE', '/api/delete', { model });
  }

  /** Downloads a model; each progress line as it comes. Closing (the signal) cancels it in Ollama. */
  async *pull(model: string, signal: AbortSignal): AsyncGenerator<OllamaPullLine> {
    for await (const line of this.stream('/api/pull', { model }, signal)) {
      const progress = line as OllamaPullLine;
      if (progress.error) throw new OllamaError(progress.error, 200);
      yield progress;
    }
  }

  /** An answer, piece by piece. */
  async *chat(
    model: string,
    messages: OllamaMessage[],
    contextTokens: number,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const body = { model, messages, options: { num_ctx: contextTokens } };
    for await (const raw of this.stream('/api/chat', body, signal)) {
      const line = chatLineSchema.parse(raw);
      if (line.error) throw new OllamaError(line.error, 200);
      if (line.message?.content) yield line.message.content;
      if (line.done) return;
    }
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(method, path, body, AbortSignal.timeout(OLLAMA_REQUEST_MS));
    return response.json();
  }

  /** NDJSON lines; given up after `OLLAMA_IDLE_MS` without a byte. */
  private async *stream(path: string, body: unknown, signal: AbortSignal): AsyncGenerator<unknown> {
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(), OLLAMA_IDLE_MS);
    const both = AbortSignal.any([signal, idle.signal]);
    try {
      const response = await this.request('POST', path, body, both);
      if (!response.body) throw new OllamaError('No answer body', response.status);
      const decoder = new TextDecoder();
      let rest = '';
      for await (const chunk of response.body) {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), OLLAMA_IDLE_MS);
        rest += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = rest.indexOf('\n')) >= 0) {
          const text = rest.slice(0, end).trim();
          rest = rest.slice(end + 1);
          if (text) yield JSON.parse(text);
        }
      }
      if (rest.trim()) yield JSON.parse(rest);
    } catch (error) {
      if (idle.signal.aborted && !signal.aborted) throw new OllamaError('No answer in time', 0);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        signal,
        redirect: 'error',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new OllamaError('Ollama is not reachable', 0);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const message = /"error"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? `HTTP ${response.status}`;
      throw new OllamaError(message, response.status);
    }
    return response;
  }
}
