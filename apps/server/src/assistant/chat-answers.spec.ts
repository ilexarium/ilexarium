import { AI_LIMITS, type ChatMessage, type ChatStreamEvent } from '@homelab/shared';
import { FakeOllama } from '../../test/fake-ollama.js';
import { ChatAnswers, fitting } from './chat-answers.js';
import type { ChatStore } from './chat-store.js';
import { OllamaClient } from './ollama-client.js';
import type { OllamaService } from './ollama-service.js';

const CHAT_ID = '0199f000-0000-7000-8000-000000000001';

/** An in-memory stand-in for the database part. */
function fakeStore() {
  const messages: ChatMessage[] = [];
  let next = 0;
  const message = (
    role: 'user' | 'assistant',
    content: string,
    model: string | null,
    stopped: boolean,
  ) => {
    const row: ChatMessage = {
      id: `0199f000-0000-7000-8000-${String(++next).padStart(12, '0')}`,
      role,
      content,
      model,
      stopped,
      createdAt: new Date().toISOString(),
    };
    messages.push(row);
    return row;
  };
  const store = {
    messages,
    ask: vi.fn(async (_user: string, chatId: string | null, model: string, content: string) => {
      if (chatId && chatId !== CHAT_ID) return null;
      return {
        chat: { id: CHAT_ID, title: content, model, updatedAt: new Date().toISOString() },
        question: message('user', content, null, false),
      };
    }),
    history: vi.fn(async () => [...messages]),
    answer: vi.fn(async (_chat: string, model: string, content: string, stopped: boolean) =>
      message('assistant', content, model, stopped),
    ),
  };
  return store;
}

describe('ChatAnswers', () => {
  let ollama: FakeOllama;
  let store: ReturnType<typeof fakeStore>;
  let answers: ChatAnswers;
  let events: ChatStreamEvent[];
  const sink = { write: async (event: ChatStreamEvent) => void events.push(event) };
  const send = (content = 'Hi', model = 'smollm2:135m') => ({ chatId: null, model, content });

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    store = fakeStore();
    events = [];
    const service = {
      client: async () => ({
        client: new OllamaClient(ollama.baseUrl),
        location: { baseUrl: ollama.baseUrl, modelsDir: null },
      }),
    } as unknown as OllamaService;
    answers = new ChatAnswers(service, store as unknown as ChatStore);
  });

  afterEach(() => ollama.stop());

  it('saves the question, streams the answer and saves it', async () => {
    await answers.answer('u1', send(), sink, new AbortController().signal);
    expect(events.map((e) => e.type)).toEqual(['chat', 'text', 'text', 'text', 'done']);
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>;
    expect(done.answer).toMatchObject({
      role: 'assistant',
      content: 'Hello there!',
      stopped: false,
    });
    expect(store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('refuses a model that is not installed, before saving anything', async () => {
    await expect(
      answers.answer('u1', send('Hi', 'nope:1b'), sink, new AbortController().signal),
    ).rejects.toMatchObject({
      response: { code: 'model_not_found' },
    });
    expect(store.messages).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses a chat that is not the person’s own', async () => {
    const other = { ...send(), chatId: '0199f000-0000-7000-8000-0000000000ff' };
    await expect(
      answers.answer('u1', other, sink, new AbortController().signal),
    ).rejects.toMatchObject({
      response: { code: 'chat_not_found' },
    });
  });

  it('writes one answer at a time per person', async () => {
    ollama.answer = { pieces: ['a'], hang: true };
    const stop = new AbortController();
    const first = answers.answer('u1', send(), sink, stop.signal);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'text')).toBe(true));
    await expect(
      answers.answer('u1', send(), sink, new AbortController().signal),
    ).rejects.toMatchObject({
      response: { code: 'answer_running' },
    });
    // Someone else isn't held up.
    ollama.answer = { pieces: ['b'] };
    await answers.answer('u2', send(), { write: async () => {} }, new AbortController().signal);
    stop.abort();
    await first;
    // Once it ended, the next one is fine.
    await answers.answer('u1', send(), sink, new AbortController().signal);
  });

  it('keeps what was written when stopped, marked stopped, and writes no error', async () => {
    ollama.answer = { pieces: ['Part', ' one'], hang: true };
    const stop = new AbortController();
    const running = answers.answer('u1', send(), sink, stop.signal);
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'text')).toHaveLength(2));
    stop.abort();
    await running;
    expect(store.messages.at(-1)).toMatchObject({ content: 'Part one', stopped: true });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    await vi.waitFor(() => expect(ollama.closed).toContain('/api/chat'));
  });

  it('saves no empty answer: a model that wrote nothing has failed', async () => {
    ollama.answer = { pieces: [] };
    await answers.answer('u1', send(), sink, new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'answer_failed', answer: null });
    expect(store.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('ends with an error line when the model fails, keeping the part written', async () => {
    ollama.answer = { pieces: ['Part'], error: 'model crashed' };
    await answers.answer('u1', send(), sink, new AbortController().signal);
    const last = events.at(-1) as Extract<ChatStreamEvent, { type: 'error' }>;
    expect(last.type).toBe('error');
    expect(last.code).toBe('answer_failed');
    expect(last.answer).toMatchObject({ content: 'Part', stopped: true });
  });
});

describe('fitting', () => {
  const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({
    id: '0199f000-0000-7000-8000-000000000009',
    role,
    content,
    model: null,
    stopped: false,
    createdAt: '2026-10-19T00:00:00.000Z',
  });

  it('keeps the newest messages that fit, oldest first', () => {
    const half = 'x'.repeat(AI_LIMITS.historyMax / 2);
    const history = [msg('user', 'old'), msg('assistant', half), msg('user', half)];
    expect(fitting(history).map((m) => m.content)).toEqual([half, half]);
  });

  it('leaves out empty messages', () => {
    expect(fitting([msg('user', 'a'), msg('assistant', ''), msg('user', 'b')])).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
  });

  it('always keeps the question', () => {
    const big = 'x'.repeat(AI_LIMITS.historyMax + 1);
    expect(fitting([msg('assistant', 'a'), msg('user', big)])).toEqual([
      { role: 'user', content: big },
    ]);
  });
});
