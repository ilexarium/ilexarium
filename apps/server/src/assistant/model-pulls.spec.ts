import { FakeOllama } from '../../test/fake-ollama.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SystemReader } from '../host/system-reader.js';
import { FREE_SPACE_MARGIN_BYTES } from './assistant.constants.js';
import { ModelPulls } from './model-pulls.js';
import { OllamaService } from './ollama-service.js';

const BY = {
  user: { id: '0199f000-0000-7000-8000-000000000001', username: 'owner' },
  ip: '127.0.0.1',
};
const GB = 1024 ** 3;

describe('ModelPulls', () => {
  let ollama: FakeOllama;
  let free: number;
  let audit: { record: ReturnType<typeof vi.fn>; tryRecord: ReturnType<typeof vi.fn> };
  let pulls: ModelPulls;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    free = 100 * GB;
    audit = { record: vi.fn(async () => {}), tryRecord: vi.fn(async () => {}) };
    const service = new OllamaService({} as never);
    vi.spyOn(service, 'location').mockImplementation(async () => ({
      baseUrl: ollama.baseUrl,
      modelsDir: '/srv/homelab/ollama',
    }));
    const host = { space: vi.fn(async () => ({ totalBytes: 200 * GB, freeBytes: free })) };
    pulls = new ModelPulls(
      service,
      host as unknown as SystemReader,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => ollama.stop());

  const finished = () => vi.waitFor(() => expect(pulls.view()?.status).not.toBe('running'));

  it('downloads, adding up the parts, and records it (asked first)', async () => {
    ollama.pull.lines.push(
      { status: 'pulling b', digest: 'sha256:b', total: 500, completed: 0 },
      { status: 'pulling b', digest: 'sha256:b', total: 500, completed: 500 },
    );
    const started = await pulls.start('smollm2:135m', BY);
    expect(started).toMatchObject({ model: 'smollm2:135m', status: 'running' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'requested', action: 'assistant.model_pull' }),
    );
    await finished();
    expect(pulls.view()).toMatchObject({
      status: 'succeeded',
      completedBytes: 1500,
      totalBytes: 1500,
      errorCode: null,
    });
    expect(audit.tryRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('downloads one model at a time', async () => {
    ollama.pull = { lines: [{ status: 'pulling manifest' }], hang: true };
    await pulls.start('smollm2:135m', BY);
    await expect(pulls.start('qwen2.5:0.5b', BY)).rejects.toMatchObject({
      response: { code: 'pull_running' },
    });
    pulls.onModuleDestroy();
  });

  it('does nothing when the audit log can’t be written (no record, no download)', async () => {
    audit.record.mockRejectedValueOnce(new Error('database down'));
    await expect(pulls.start('smollm2:135m', BY)).rejects.toThrow('database down');
    expect(ollama.requests.some((r) => r.url === '/api/pull')).toBe(false);
    // Not stuck: the next one can start.
    await pulls.start('smollm2:135m', BY);
    await finished();
  });

  it('refuses when the models disk is already full', async () => {
    free = FREE_SPACE_MARGIN_BYTES - 1;
    await expect(pulls.start('smollm2:135m', BY)).rejects.toMatchObject({
      response: { code: 'not_enough_space' },
    });
  });

  it('stops a download that would fill the disk', async () => {
    free = FREE_SPACE_MARGIN_BYTES + 500;
    ollama.pull = {
      lines: [{ status: 'pulling a', digest: 'sha256:a', total: 4000, completed: 0 }],
      hang: true,
    };
    await pulls.start('big:70b', BY);
    await finished();
    expect(pulls.view()).toMatchObject({ status: 'failed', errorCode: 'not_enough_space' });
    await vi.waitFor(() => expect(ollama.closed).toContain('/api/pull'));
  });

  it('says a model doesn’t exist when Ollama can’t find it', async () => {
    ollama.pull = {
      lines: [{ status: 'pulling manifest' }],
      error: 'pull model manifest: file does not exist',
    };
    await pulls.start('nope:1b', BY);
    await finished();
    expect(pulls.view()).toMatchObject({ status: 'failed', errorCode: 'model_not_found' });
    expect(audit.tryRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it('refuses when Ollama isn’t installed', async () => {
    const service = new OllamaService({} as never);
    vi.spyOn(service, 'location').mockResolvedValue(null);
    const none = new ModelPulls(service, {} as SystemReader, audit as unknown as AuditService);
    await expect(none.start('smollm2:135m', BY)).rejects.toMatchObject({
      response: { code: 'ollama_not_installed' },
    });
  });
});
