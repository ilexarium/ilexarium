// The wrappers' entries load the rest of the program (lib/ and their own folder) only after
// checking that nobody but its owner (root, in production) can change any of it — every module
// runs as root too. Run by the server's unit tests.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPERS = fileURLToPath(new URL('.', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wrapper-entry-'));
  cpSync(WRAPPERS, dir, { recursive: true, filter: (src) => !src.endsWith('.spec.ts') });
  chmodSync(dir, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs an entry with no configuration: it gets as far as its first own check, or not. */
function start(entry: string) {
  const result = spawnSync(process.execPath, [join(dir, entry), 'passphrase'], {
    env: {},
    input: '',
  });
  return { code: result.status, out: result.stdout.toString() };
}

describe.each(['homelab-backup.mts', 'homelab-compose.mts'])('%s', (entry) => {
  const area = entry === 'homelab-backup.mts' ? 'backup' : 'compose';

  it('loads its modules when only their owner can change them', () => {
    // Past the module check: the program itself answers (no config, or not an action of it).
    const { out } = start(entry);
    expect(out).toMatch(/@@error code=(setup|invalid_request)/);
    expect(out).not.toContain('must belong to root');
  });

  it.each([
    ['a shared module others may change', 'lib/output.mts'],
    [`one of its own modules others may change`, `${area}/main.mts`],
  ])('refuses %s — before running any of it', (_, module) => {
    chmodSync(join(dir, module), 0o664);
    const { code, out } = start(entry);
    expect(code).toBe(6);
    expect(out).toContain(`${join(dir, module)} must belong to root`);
    expect(out.trim().split('\n').at(-1)).toBe('@@error code=setup');
  });

  it('refuses a module folder others may change (a module could be added or swapped)', () => {
    chmodSync(join(dir, 'lib'), 0o777);
    expect(start(entry).code).toBe(6);
  });

  it('refuses a module replaced by a symlink', () => {
    const module = join(dir, area, 'main.mts');
    const elsewhere = join(dir, 'elsewhere.mts');
    writeFileSync(elsewhere, 'console.log("@@phase done")');
    unlinkSync(module);
    symlinkSync(elsewhere, module);
    const { code, out } = start(entry);
    expect(code).toBe(6);
    expect(out).not.toContain('@@phase done');
  });
});
