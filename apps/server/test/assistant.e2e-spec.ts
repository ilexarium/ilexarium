import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AI_LIMITS, type Chat, type ChatList, type ChatStreamEvent } from '@homelab/shared';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { ModelPulls } from '../src/assistant/model-pulls.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';
import { FakeOllama } from './fake-ollama.js';
import { testHasher } from './realtime-client.js';

// The Assistant end to end (docs/plans/ai_assistant.md): a fake Ollama on a loopback port stands
// in for the installed `ollama` service; chats in the real database, by owner.

const PASSWORD = 'correct horse battery staple';

describe('assistant (e2e)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let prisma: PrismaService;
  let ollama: FakeOllama;
  let owner: string;
  let other: string;

  const as = (cookie: string) => ({
    get: (path: string) => request(origin).get(`/api${path}`).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      request(origin).post(`/api${path}`).set('Origin', origin).set('Cookie', cookie).send(body),
    delete: (path: string) =>
      request(origin).delete(`/api${path}`).set('Origin', origin).set('Cookie', cookie),
  });

  async function signIn(username: string): Promise<string> {
    await app.get(UsersService).create({ username, passwordHash: await testHasher.hash(PASSWORD) });
    const login = await request(origin)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ username, password: PASSWORD })
      .expect(200);
    return ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-sid='))!
      .split(';')[0];
  }

  /** Ollama "installed": the service row the app finds it by. */
  async function install(port = ollama.port): Promise<void> {
    await prisma.service.create({
      data: {
        catalogId: 'ollama',
        catalogVersion: '1',
        status: 'installed',
        // A real folder: downloads need its free space (they're refused when it can't be read).
        settings: { API_PORT: port, MODELS_DIR: tmpdir() },
      },
    });
  }

  /** The streamed answer, as its lines. */
  async function chat(cookie: string, body: object) {
    const response = await as(cookie).post('/assistant/chat', body);
    const events =
      response.status === 200
        ? (response.text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)) as ChatStreamEvent[])
        : [];
    return { response, events };
  }

  beforeAll(async () => {
    ollama = await new FakeOllama().start();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(testHasher)
      .compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    // Signed in once: sign-ins are rate-limited.
    await resetDatabase(prisma);
    owner = await signIn('owner');
    other = await signIn('anna');
  }, 60_000);

  beforeEach(async () => {
    await prisma.chat.deleteMany();
    await prisma.service.deleteMany();
    await prisma.auditEvent.deleteMany();
    ollama.models = [{ name: 'smollm2:135m', size: 270_898_672 }];
    ollama.answer = { pieces: ['Hello', ' there', '!'] };
    ollama.requests.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await ollama?.stop();
  });

  it('needs a session', async () => {
    await request(origin).get('/api/assistant/status').expect(401);
    await request(origin).get('/api/assistant/chats').expect(401);
    await request(origin).post('/api/assistant/chat').set('Origin', origin).send({}).expect(401);
  });

  it('says whether Ollama is installed and running', async () => {
    expect((await as(owner).get('/assistant/status').expect(200)).body).toEqual({
      state: 'not_installed',
      version: null,
    });
    await as(owner)
      .get('/assistant/models')
      .expect(503)
      .expect((r) => expect(r.body.code).toBe('ollama_not_installed'));
    await install();
    expect((await as(owner).get('/assistant/status').expect(200)).body).toEqual({
      state: 'ready',
      version: '0.40.6',
    });
  });

  it('says when an installed Ollama is not running', async () => {
    await install(1); // nothing listens there
    expect((await as(owner).get('/assistant/status').expect(200)).body.state).toBe('not_running');
    await as(owner)
      .get('/assistant/models')
      .expect(503)
      .expect((r) => expect(r.body.code).toBe('ollama_unreachable'));
  });

  it('lists the installed models', async () => {
    await install();
    ollama.loaded = ['smollm2:135m'];
    expect((await as(owner).get('/assistant/models').expect(200)).body.models).toEqual([
      {
        name: 'smollm2:135m',
        sizeBytes: 270_898_672,
        family: 'llama',
        parameterSize: '134.52M',
        quantization: 'F16',
        modifiedAt: '2026-10-19T12:57:13.171Z',
        loaded: true,
      },
    ]);
  });

  it('answers a message as a stream, saves the chat, and continues it', async () => {
    await install();
    const first = await chat(owner, { chatId: null, model: 'smollm2:135m', content: 'Say hello' });
    expect(first.response.status).toBe(200);
    expect(first.response.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(first.events.map((e) => e.type)).toEqual(['chat', 'text', 'text', 'text', 'done']);
    const started = first.events[0] as Extract<ChatStreamEvent, { type: 'chat' }>;
    expect(started.chat.title).toBe('Say hello');

    const list = (await as(owner).get('/assistant/chats').expect(200)).body as ChatList;
    expect(list.chats.map((c) => c.id)).toEqual([started.chat.id]);

    const again = await chat(owner, {
      chatId: started.chat.id,
      model: 'smollm2:135m',
      content: 'More',
    });
    expect(again.events.at(-1)?.type).toBe('done');
    // The model got the whole conversation.
    const sent = ollama.requests.filter((r) => r.url === '/api/chat').at(-1)!.body;
    expect(sent.messages.map((m: { content: string }) => m.content)).toEqual([
      'Say hello',
      'Hello there!',
      'More',
    ]);

    const saved = (await as(owner).get(`/assistant/chats/${started.chat.id}`).expect(200))
      .body as Chat;
    expect(saved.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there!'],
      ['user', 'More'],
      ['assistant', 'Hello there!'],
    ]);
  });

  it("keeps each person's chats their own", async () => {
    await install();
    const { events } = await chat(owner, { chatId: null, model: 'smollm2:135m', content: 'Mine' });
    const id = (events[0] as Extract<ChatStreamEvent, { type: 'chat' }>).chat.id;

    expect((await as(other).get('/assistant/chats').expect(200)).body.chats).toEqual([]);
    await as(other).get(`/assistant/chats/${id}`).expect(404);
    await as(other).delete(`/assistant/chats/${id}`).expect(404);
    const sent = await chat(other, { chatId: id, model: 'smollm2:135m', content: 'Theirs?' });
    expect(sent.response.status).toBe(404);
    expect(sent.response.body.code).toBe('chat_not_found');

    await as(owner).delete(`/assistant/chats/${id}`).expect(204);
    await as(owner).get(`/assistant/chats/${id}`).expect(404);
  });

  it('goes with its owner', async () => {
    await install();
    await chat(other, { chatId: null, model: 'smollm2:135m', content: 'Mine' });
    expect(await prisma.chat.count()).toBe(1);
    await prisma.user.delete({ where: { username: 'anna' } });
    expect(await prisma.chat.count()).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
    other = await signIn('anna');
  });

  it.each([
    ['an empty message', { content: '   ' }],
    ['a message too long', { content: 'x'.repeat(AI_LIMITS.messageMax + 1) }],
    ['a model name that is not one', { model: '../etc' }],
    ['a chat id that is not one', { chatId: 'abc' }],
    ['an unknown field', { extra: 1 }],
  ])('refuses %s', async (_, change) => {
    await install();
    const body = { chatId: null, model: 'smollm2:135m', content: 'Hi', ...change };
    await as(owner).post('/assistant/chat', body).expect(400);
    expect(await prisma.chat.count()).toBe(0);
  });

  it('refuses a model that is not installed', async () => {
    await install();
    const sent = await chat(owner, { chatId: null, model: 'nope:1b', content: 'Hi' });
    expect(sent.response.status).toBe(404);
    expect(sent.response.body.code).toBe('model_not_found');
  });

  it('removes a model, audited', async () => {
    await install();
    await as(owner).delete('/assistant/models?model=smollm2:135m').expect(204);
    expect(ollama.models).toEqual([]);
    await as(owner).delete('/assistant/models?model=smollm2:135m').expect(404);
    await as(owner).delete('/assistant/models?model=..%2Fetc').expect(400);
    const events = await prisma.auditEvent.findMany({
      where: { action: 'assistant.model_remove' },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    expect(events.map((e) => e.outcome)).toEqual(['requested', 'success', 'requested', 'failure']);
  });

  it('downloads a model in the background, one at a time, audited', async () => {
    await install();
    const started = await as(owner)
      .post('/assistant/models/pull', { model: 'qwen2.5:0.5b' })
      .expect(202);
    expect(started.body).toMatchObject({ model: 'qwen2.5:0.5b', status: 'running' });
    await vi.waitFor(() => expect(app.get(ModelPulls).view()?.status).toBe('succeeded'));
    // The `ollama` library sends the name as `name` (Ollama takes both).
    expect(ollama.requests.find((r) => r.url === '/api/pull')?.body).toMatchObject({
      name: 'qwen2.5:0.5b',
      stream: true,
    });
    const outcomes = (
      await prisma.auditEvent.findMany({
        where: { action: 'assistant.model_pull' },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      })
    ).map((e) => e.outcome);
    expect(outcomes).toEqual(['requested', 'success']);
    await as(owner).post('/assistant/models/pull', { model: 'bad name' }).expect(400);
    // Ollama pulls from the host a name starts with: only Hugging Face's.
    await as(owner)
      .post('/assistant/models/pull', { model: '192.168.1.10/library/llama3:1b' })
      .expect(400);
  });

  it('checks the Hugging Face names before asking anything', async () => {
    await as(owner).get('/assistant/library/..%2F..%2Fx/y').expect(400);
    await as(owner).get('/assistant/library/a%3Fb/y').expect(400);
    await as(owner)
      .get(`/assistant/library?search=${'x'.repeat(AI_LIMITS.searchMax + 1)}`)
      .expect(400);
  });
});
