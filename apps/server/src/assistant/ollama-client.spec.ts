import { FakeOllama } from '../../test/fake-ollama.js';
import { OllamaClient, OllamaError } from './ollama-client.js';

describe('OllamaClient', () => {
  let ollama: FakeOllama;
  let client: OllamaClient;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    client = new OllamaClient(ollama.baseUrl);
  });

  afterEach(() => ollama.stop());

  it('reads the version, the models and which are loaded', async () => {
    ollama.loaded = ['smollm2:135m'];
    expect(await client.version()).toBe('0.40.6');
    expect((await client.tags()).models.map((model) => model.name)).toEqual(['smollm2:135m']);
    expect(await client.loaded()).toEqual(new Set(['smollm2:135m']));
  });

  it('streams an answer piece by piece, asking for the context window', async () => {
    const pieces: string[] = [];
    const messages = [{ role: 'user' as const, content: 'hi' }];
    for await (const piece of client.chat(
      'smollm2:135m',
      messages,
      8192,
      new AbortController().signal,
    )) {
      pieces.push(piece);
    }
    expect(pieces).toEqual(['Hello', ' there', '!']);
    const request = ollama.requests.find((r) => r.url === '/api/chat')!;
    expect(request.body).toMatchObject({
      model: 'smollm2:135m',
      messages,
      stream: true,
      options: { num_ctx: 8192 },
    });
  });

  it('reports an error line in a stream as an error', async () => {
    ollama.answer = { pieces: ['Part'], error: 'model crashed' };
    const pieces: string[] = [];
    await expect(async () => {
      for await (const piece of client.chat(
        'smollm2:135m',
        [],
        8192,
        new AbortController().signal,
      )) {
        pieces.push(piece);
      }
    }).rejects.toThrow('model crashed');
    expect(pieces).toEqual(['Part']);
  });

  it("tells Ollama's own refusals (a missing model) by status and message", async () => {
    const error = await client.remove('nope:1b').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OllamaError);
    expect(error).toMatchObject({ status: 404, message: "model 'nope:1b' not found" });
  });

  it('stops a stream when asked, and Ollama sees the request closed', async () => {
    ollama.answer = { pieces: ['a'], hang: true };
    const stop = new AbortController();
    const pieces: string[] = [];
    await expect(async () => {
      for await (const piece of client.chat('smollm2:135m', [], 8192, stop.signal)) {
        pieces.push(piece);
        stop.abort();
      }
    }).rejects.toThrow();
    expect(pieces).toEqual(['a']);
    await vi.waitFor(() => expect(ollama.closed).toContain('/api/chat'));
  });

  it('reports a download error line as an error', async () => {
    ollama.pull = {
      lines: [{ status: 'pulling manifest' }],
      error: 'pull model manifest: file does not exist',
    };
    await expect(async () => {
      for await (const _ of client.pull('nope:1b', new AbortController().signal)) {
        // progress
      }
    }).rejects.toThrow('file does not exist');
  });

  it('treats a stream that breaks off before it’s done as an error, not a finished answer', async () => {
    ollama.answer = { pieces: ['Half an'], cut: true };
    const pieces: string[] = [];
    await expect(async () => {
      for await (const piece of client.chat(
        'smollm2:135m',
        [],
        8192,
        new AbortController().signal,
      )) {
        pieces.push(piece);
      }
    }).rejects.toBeInstanceOf(OllamaError);
    expect(pieces).toEqual(['Half an']);
  });

  it('follows no redirect', async () => {
    ollama.redirect = true;
    await expect(client.version()).rejects.toMatchObject({ status: 0 });
    expect(ollama.requests).toHaveLength(1);
  });

  it('says so when nothing answers', async () => {
    await ollama.stop();
    await expect(client.version()).rejects.toMatchObject({ status: 0 });
  });
});
