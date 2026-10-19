import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type {
  AiModel,
  AiStatus,
  Chat,
  ChatMessage,
  ChatStreamEvent,
  ChatSummary,
} from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { Subject } from 'rxjs';
import { AssistantApi } from '../../../core/assistant/assistant-api';
import { ChatPage } from './chat-page';

const CHAT_ID = '0199f000-0000-7000-8000-000000000001';
const OLD_ID = '0199f000-0000-7000-8000-0000000000aa';

const model = (name: string): AiModel => ({
  name,
  sizeBytes: 270_898_672,
  family: 'llama',
  parameterSize: '134.52M',
  quantization: 'F16',
  modifiedAt: '2026-10-19T12:00:00.000Z',
  loaded: false,
});
const summary = (id: string, title: string): ChatSummary => ({
  id,
  title,
  model: 'smollm2:135m',
  updatedAt: '2026-10-19T12:00:00.000Z',
});
const message = (
  role: 'user' | 'assistant',
  content: string,
  change: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: `0199f000-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
  role,
  content,
  model: role === 'assistant' ? 'smollm2:135m' : null,
  stopped: false,
  createdAt: '2026-10-19T12:00:00.000Z',
  ...change,
});

function fakeApi(status: AiStatus = { state: 'ready', version: '0.40.6' }) {
  const answers: Subject<ChatStreamEvent>[] = [];
  return {
    answers,
    status: vi.fn(async () => status),
    models: vi.fn(async () => ({ models: [model('smollm2:135m'), model('qwen2.5:0.5b')] })),
    chats: vi.fn(async () => ({ chats: [summary(OLD_ID, 'An older chat')] })),
    chat: vi.fn(async (id: string): Promise<Chat> => ({
      ...summary(id, 'An older chat'),
      createdAt: '2026-10-19T11:00:00.000Z',
      messages: [message('user', 'Old question'), message('assistant', 'Old **answer**')],
    })),
    removeChat: vi.fn(async () => undefined),
    send: vi.fn(() => {
      const answer = new Subject<ChatStreamEvent>();
      answers.push(answer);
      return answer.asObservable();
    }),
  };
}

async function render(api = fakeApi(), url = '/assistant') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'assistant', component: ChatPage }]),
      { provide: AssistantApi, useValue: api },
    ],
  });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const fixture = TestBed.createComponent(ChatPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const textarea = () => el.querySelector<HTMLTextAreaElement>('textarea')!;
  const type = async (text: string) => {
    textarea().value = text;
    textarea().dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const submit = async () => {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
  };
  return { fixture, el, api, router, type, submit, textarea };
}

describe('ChatPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('points to the Services page while Ollama isn’t installed', async () => {
    const { el } = await render(fakeApi({ state: 'not_installed', version: null }));
    expect(el.textContent).toContain('Ollama isn’t installed');
    expect(el.querySelector('a[href="/services"]')?.textContent).toContain('Install Ollama');
    expect(el.querySelector('textarea')).toBeNull();
  });

  it('points to the Models page while no model is installed', async () => {
    const api = fakeApi();
    api.models.mockResolvedValue({ models: [] });
    const { el } = await render(api);
    expect(el.textContent).toContain('No model installed');
    expect(el.querySelector('a[href="/assistant/models"]')).toBeTruthy();
  });

  it('starts a new chat: the question, the answer as it’s written, then its own URL', async () => {
    const { el, fixture, api, router, type, submit } = await render();
    expect(el.textContent).toContain('Ask anything');
    await type('Say hello');
    await submit();
    expect(api.send).toHaveBeenCalledWith({
      chatId: null,
      model: 'smollm2:135m',
      content: 'Say hello',
    });
    // Thinking until the first words.
    expect(el.textContent).toContain('Thinking…');

    const answer = api.answers[0];
    const question = message('user', 'Say hello');
    answer.next({ type: 'chat', chat: summary(CHAT_ID, 'Say hello'), question });
    answer.next({ type: 'text', text: 'Hello' });
    await fixture.whenStable();
    expect(el.textContent).toContain('Say hello');
    expect(el.querySelector('app-chat-thread')!.textContent).toContain('Hello');
    expect(el.querySelector('button[aria-label="Stop the answer"]')).toBeTruthy();
    expect(router.url).toBe(`/assistant?chat=${CHAT_ID}`);

    answer.next({ type: 'done', answer: message('assistant', 'Hello **there**') });
    answer.complete();
    await fixture.whenStable();
    expect(el.querySelector('app-markdown-view strong')?.textContent).toBe('there');
    expect(el.querySelector('button[aria-label="Send"]')).toBeTruthy();
    // The box is empty again; the chat is first in the list.
    expect(el.querySelector('textarea')!.value).toBe('');
    expect(el.querySelector('app-chat-list a[aria-current="page"]')?.textContent).toContain(
      'Say hello',
    );
  });

  it('stops an answer, keeping what was written', async () => {
    const { el, fixture, api, type, submit } = await render();
    await type('Tell me a story');
    await submit();
    api.answers[0].next({
      type: 'chat',
      chat: summary(CHAT_ID, 'Tell me a story'),
      question: message('user', 'Tell me a story'),
    });
    api.answers[0].next({ type: 'text', text: 'Once upon' });
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('button[aria-label="Stop the answer"]')!.click();
    await fixture.whenStable();
    expect(api.answers[0].observed).toBe(false);
    const thread = el.querySelector('app-chat-thread')!.textContent!;
    expect(thread).toContain('Once upon');
    expect(thread).toContain('stopped');
  });

  it('keeps the text when the message is refused, and says why', async () => {
    const error = vi.spyOn(toast, 'error');
    const { el, fixture, api, type, submit } = await render();
    await type('Hi');
    await submit();
    api.answers[0].error(
      new HttpErrorResponse({
        status: 409,
        error: { message: 'An answer is being written', code: 'answer_running' },
      }),
    );
    await fixture.whenStable();
    expect(error).toHaveBeenCalledWith('The message wasn’t sent', {
      description: 'An answer is still being written. Wait for it or stop it.',
    });
    expect(el.querySelector('textarea')!.value).toBe('Hi');
  });

  it('opens a chat from the URL, with its model chosen', async () => {
    const { el, api } = await render(fakeApi(), `/assistant?chat=${OLD_ID}`);
    expect(api.chat).toHaveBeenCalledWith(OLD_ID);
    expect(el.textContent).toContain('Old question');
    expect(el.querySelector('app-markdown-view strong')?.textContent).toBe('answer');
  });

  it('sends with Enter, but Shift+Enter is a new line', async () => {
    const { api, type, textarea, fixture } = await render();
    await type('First line');
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    await fixture.whenStable();
    expect(api.send).not.toHaveBeenCalled();
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await fixture.whenStable();
    expect(api.send).toHaveBeenCalled();
  });

  it('deletes a chat after a confirmation', async () => {
    const { el, fixture, api } = await render(fakeApi(), `/assistant?chat=${OLD_ID}`);
    el.querySelector<HTMLButtonElement>(
      'app-chat-list button[aria-label^="Delete the chat"]',
    )!.click();
    await fixture.whenStable();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Delete “An older chat”?');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete')!.click();
    await fixture.whenStable();
    expect(api.removeChat).toHaveBeenCalledWith(OLD_ID);
    expect(el.querySelector('app-chat-list')!.textContent).not.toContain('An older chat');
  });
});
