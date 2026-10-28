// lib/output.mts: what happens when nobody reads a wrapper's output any more (the app stopped
// mid-operation). The wrapper must finish its work — a restore starts its service again — not
// crash on the next line it prints. Run by the server's unit tests.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUTPUT = new URL('./lib/output.mts', import.meta.url).href;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wrapper-output-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('goes on with its work once the reader of its output is gone', async () => {
  const done = join(dir, 'done');
  const script = join(dir, 'work.mts');
  // Prints after the reader closed, then does the rest of its work (here: writes a file).
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
import { emit } from ${JSON.stringify(OUTPUT)};
setTimeout(() => {
  for (let i = 0; i < 100; i++) emit('@@phase starting');
  writeFileSync(${JSON.stringify(done)}, 'yes');
}, 300);
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  child.stdout.destroy();
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

  expect(errors).toBe('');
  expect(code).toBe(0);
  expect(existsSync(done)).toBe(true);
});
