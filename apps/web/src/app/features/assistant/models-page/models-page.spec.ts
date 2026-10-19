import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AiLibraryDetail, AiModel, AiPull } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AssistantApi } from '../../../core/assistant/assistant-api';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { ModelsPage } from './models-page';

const model = (name: string, loaded = false): AiModel => ({
  name,
  sizeBytes: 2_019_393_189,
  family: 'llama',
  parameterSize: '3.2B',
  quantization: 'Q4_K_M',
  modifiedAt: '2026-10-19T12:00:00.000Z',
  loaded,
});
const pull = (change: Partial<AiPull> = {}): AiPull => ({
  model: 'qwen2.5:0.5b',
  status: 'running',
  completedBytes: 0,
  totalBytes: 0,
  errorCode: null,
  startedAt: '2026-10-19T12:00:00.000Z',
  finishedAt: null,
  ...change,
});
const DETAIL: AiLibraryDetail = {
  id: 'bartowski/SmolLM2-135M-Instruct-GGUF',
  gated: false,
  license: 'apache-2.0',
  files: [
    {
      quantization: 'Q4_K_M',
      sizeBytes: 105_000_000,
      model: 'hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M',
    },
    {
      quantization: 'Q8_0',
      sizeBytes: 145_000_000,
      model: 'hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q8_0',
    },
  ],
};

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const api = {
    status: vi.fn(async () => ({ state: 'ready' as const, version: '0.40.6' })),
    models: vi.fn(async () => ({ models: [model('llama3.2:3b', true)] })),
    pull: vi.fn(async (name: string) => pull({ model: name })),
    removeModel: vi.fn(async () => undefined),
    search: vi.fn(async () => ({
      models: [{ id: DETAIL.id, downloads: 52_592, likes: 18, updatedAt: null }],
    })),
    libraryDetail: vi.fn(async () => DETAIL),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: AssistantApi, useValue: api },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(ModelsPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const fill = async (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    input.form!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
  };
  const topic = async (data: AiPull | null) => {
    socket.receive({ event: 'assistant:update', data: { pull: data } });
    await fixture.whenStable();
  };
  return { fixture, el, api, socket, fill, topic };
}

describe('ModelsPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the installed models with their size and whether they’re loaded', async () => {
    const { el } = await render();
    const row = el.querySelector('app-installed-models li')!;
    expect(row.textContent).toContain('llama3.2:3b');
    expect(row.textContent).toContain('2.0 GB');
    expect(row.textContent).toContain('3.2B');
    expect(row.textContent).toContain('Loaded');
  });

  it('follows the assistant topic while open', async () => {
    const { socket } = await render();
    expect(socket.sent).toContainEqual({ event: 'subscribe', data: { topic: 'assistant' } });
  });

  it('removes a model after a confirmation', async () => {
    const { el, fixture, api } = await render();
    el.querySelector<HTMLButtonElement>('app-installed-models button')!.click();
    await fixture.whenStable();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Remove llama3.2:3b?');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Remove')!.click();
    await fixture.whenStable();
    expect(api.removeModel).toHaveBeenCalledWith('llama3.2:3b');
    expect(el.querySelector('app-installed-models')).toBeNull();
  });

  it('downloads by name, shows the progress, then the new model', async () => {
    const success = vi.spyOn(toast, 'success');
    const { el, api, fill, topic } = await render();
    await fill('#model-name', 'qwen2.5:0.5b');
    expect(api.pull).toHaveBeenCalledWith('qwen2.5:0.5b');
    await topic(pull({ completedBytes: 200_000_000, totalBytes: 400_000_000 }));
    expect(el.querySelector('app-pull-progress')!.textContent).toContain('200 MB of 400 MB (50%)');
    api.models.mockResolvedValue({ models: [model('llama3.2:3b', true), model('qwen2.5:0.5b')] });
    await topic(
      pull({ status: 'succeeded', completedBytes: 400_000_000, totalBytes: 400_000_000 }),
    );
    await vi.waitFor(() => expect(el.querySelectorAll('app-installed-models li')).toHaveLength(2));
    expect(success).toHaveBeenCalledWith('qwen2.5:0.5b is ready');
  });

  it('refuses a name that isn’t one, without asking the server', async () => {
    const { el, api, fill } = await render();
    await fill('#model-name', 'no spaces please');
    expect(api.pull).not.toHaveBeenCalled();
    expect(el.textContent).toContain('A model name like llama3.2:3b');
  });

  it('says why a download failed', async () => {
    const error = vi.spyOn(toast, 'error');
    const { topic } = await render();
    await topic(pull());
    await topic(pull({ status: 'failed', errorCode: 'not_enough_space' }));
    expect(error).toHaveBeenCalledWith('qwen2.5:0.5b couldn’t be downloaded', {
      description: 'There isn’t enough free space on the models’ disk.',
    });
  });

  it('searches Hugging Face, opens a result and downloads a size', async () => {
    const { el, fixture, api, fill } = await render();
    await fill('#library-search', 'smollm');
    expect(api.search).toHaveBeenCalledWith('smollm');
    const result = el.querySelector<HTMLButtonElement>('app-library-results li > button')!;
    expect(result.textContent).toContain('52.6K');
    result.click();
    await vi.waitFor(() =>
      expect(el.querySelector('app-library-results')!.textContent).toContain('Q8_0'),
    );
    expect(api.libraryDetail).toHaveBeenCalledWith(DETAIL.id);
    const download = [
      ...el.querySelectorAll<HTMLButtonElement>('app-library-results li li button'),
    ][0];
    download.click();
    await fixture.whenStable();
    expect(api.pull).toHaveBeenCalledWith('hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M');
  });
});
