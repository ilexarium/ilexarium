// After a Prisma upgrade: downloads its migration engines and pins their SHA-256 in
// scripts/prisma-engines.json, which the release accepts them by (npm run release:engines).
// Review the change: from then on, only these files are released.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadEngines, engineHashes } from './lib/prisma-engines.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ilex-engines-'));
try {
  const version = await downloadEngines(ROOT, dir);
  const pinned = engineHashes(dir, version);
  writeFileSync(join(ROOT, 'scripts/prisma-engines.json'), `${JSON.stringify(pinned, null, 2)}\n`);
  console.log(pinned);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
