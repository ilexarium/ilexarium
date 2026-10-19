import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ChatStreamEvent } from '@homelab/shared';
import { AssistantApi } from './assistant-api';

const CHAT = {
  id: '0199f000-0000-7000-8000-000000000001',
  title: 'Hi',
  model: 'smollm2:135m',
  updatedAt: '2026-10-19T12:00:00.000Z',
};
const QUESTION = {
  id: '0199f000-0000-7000-8000-000000000002',
  role: 'user',
  content: 'Hi',
  model: null,
  stopped: false,
  createdAt: '2026-10-19T12:00:00.000Z',
};

describe('AssistantApi.send', () => {
  let http: HttpTestingController;
  let api: AssistantApi;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(AssistantApi);
  });

  afterEach(() => http.verify());

  it('reads the answer line by line as it arrives, a line split over two pieces too', () => {
    const events: ChatStreamEvent[] = [];
    let done = false;
    api
      .send({ chatId: null, model: 'smollm2:135m', content: 'Hi' })
      .subscribe({ next: (e) => events.push(e), complete: () => (done = true) });
    const req = http.expectOne('/api/assistant/chat');
    expect(req.request.method).toBe('POST');
    const first = `${JSON.stringify({ type: 'chat', chat: CHAT, question: QUESTION })}\n{"type":"te`;
    req.event({ type: HttpEventType.DownloadProgress, loaded: 1, partialText: first });
    expect(events.map((e) => e.type)).toEqual(['chat']);
    const second = `${first}xt","text":"Hello"}\n`;
    req.event({ type: HttpEventType.DownloadProgress, loaded: 2, partialText: second });
    expect(events.at(-1)).toEqual({ type: 'text', text: 'Hello' });
    req.flush(`${second}{"type":"text","text":"!"}\n`);
    expect(events.map((e) => e.type)).toEqual(['chat', 'text', 'text']);
    expect(done).toBe(true);
  });

  it('gives a refusal its { code }, like other calls', () => {
    let error: any;
    api
      .send({ chatId: null, model: 'x:1', content: 'Hi' })
      .subscribe({ error: (e) => (error = e) });
    http
      .expectOne('/api/assistant/chat')
      .flush('{"message":"An answer is being written","code":"answer_running"}', {
        status: 409,
        statusText: 'Conflict',
      });
    expect(error.status).toBe(409);
    expect(error.error).toEqual({ message: 'An answer is being written', code: 'answer_running' });
  });

  it('cancels the request when unsubscribed (the answer stops)', () => {
    const subscription = api.send({ chatId: null, model: 'x:1', content: 'Hi' }).subscribe();
    const req = http.expectOne('/api/assistant/chat');
    subscription.unsubscribe();
    expect(req.cancelled).toBe(true);
  });
});
