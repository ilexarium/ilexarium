// Tests for laris-root.mts on its own (the helper's spec covers it behind the helper and a fake
// sudo): what it refuses, and when it ends. Run by the server's unit tests, not as root.
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'laris-root-'));
  mkdirSync(join(dir, 'bin'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs it with these requests (stdin closed after them, unless `keepOpen`); its lines and exit. */
function run(
  requests: Record<string, unknown>[],
  options: { env?: Record<string, string>; entry?: string; keepOpen?: boolean } = {},
): Promise<{ lines: Record<string, unknown>[]; code: number | null; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, [options.entry ?? join(HERE, 'laris-root.mts')], {
    env: options.env ?? { LARIS_HELPER_FAKE_BIN: join(dir, 'bin') },
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (out += chunk));
  requests.forEach((request, index) =>
    child.stdin.write(`${JSON.stringify({ id: index + 1, ...request })}\n`),
  );
  if (!options.keepOpen) child.stdin.end();
  return new Promise((resolve) =>
    child.on('close', (code) =>
      resolve({
        lines: out
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
        code,
        ms: Date.now() - started,
      }),
    ),
  );
}

describe('laris-root', () => {
  it('refuses to start unless it is root', async () => {
    const { lines, code } = await run([{ action: 'touch' }], { env: {} });
    expect(lines).toEqual([{ 'laris-root': 1, error: 'not_root' }]);
    expect(code).toBe(6);
  });

  it('does only the privileged form of the helper’s actions', async () => {
    const { lines } = await run([
      { action: 'touch' },
      { action: 'hello' },
      { action: 'sudo.unlock', password: 'right' },
      { action: 'docker.access' },
      { action: 'paths.size', paths: ['/srv'] },
      { action: 'process.signal', pid: 1234, signal: 'TERM', administrator: false },
      { action: 'paths.remove', paths: ['/srv/x'], administrator: false },
      { action: 'compose.check', folder: dir, project: 'music', docker: 'direct' },
      { action: 'volumes.remove', names: ['x'], docker: 'direct' },
      { action: 'root.run', program: 'compose', command: 'up', input: '' },
    ]);
    expect(lines[0]).toEqual({ 'laris-root': 1 });
    expect(lines[1]).toEqual({ id: 1, ok: true });
    const refused = lines.slice(2);
    expect(refused).toHaveLength(9);
    for (const answer of refused) expect(answer).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('ends when its stdin closes, after answering what it was asked', async () => {
    const { lines, code } = await run([{ action: 'touch' }, { action: 'touch' }]);
    expect(lines.slice(1)).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: true },
    ]);
    expect(code).toBe(0);
  });

  it('ends on its own after its idle time, counted from the last request', async () => {
    const { lines, code, ms } = await run([{ action: 'touch' }], {
      env: { LARIS_HELPER_FAKE_BIN: join(dir, 'bin'), LARIS_ROOT_IDLE_MS: '300' },
      keepOpen: true,
    });
    expect(lines).toEqual([{ 'laris-root': 1 }, { id: 1, ok: true }]);
    expect(code).toBe(0);
    expect(ms).toBeGreaterThanOrEqual(300);
  });

  it('refuses to start when a module could be changed by others — the helper’s too', async () => {
    for (const module of ['root/main.mts', 'helper/run.mts']) {
      const copy = mkdtempSync(join(dir, 'copy-'));
      chmodSync(copy, 0o755);
      cpSync(join(HERE, 'laris-root.mts'), join(copy, 'laris-root.mts'));
      cpSync(join(HERE, 'root'), join(copy, 'root'), { recursive: true });
      cpSync(join(HERE, 'helper'), join(copy, 'helper'), { recursive: true });
      chmodSync(join(copy, module), 0o666);
      const { lines, code } = await run([{ action: 'touch' }], {
        entry: join(copy, 'laris-root.mts'),
      });
      expect(lines).toEqual([{ 'laris-root': 1, error: 'setup', path: join(copy, module) }]);
      expect(code).toBe(6);
    }
  });
});
