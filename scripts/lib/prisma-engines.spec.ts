// The release takes Prisma's migration engine (run as root by the installer) only as pinned.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEngines, ENGINE_TARGETS, engineHashes } from './prisma-engines.mjs';

const VERSION = 'abc123';

describe('Prisma engine pins', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engines-'));
    for (const target of ENGINE_TARGETS)
      writeFileSync(join(dir, `schema-engine-${target}`), target);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts the pinned files', () => {
    expect(() => checkEngines(dir, VERSION, engineHashes(dir, VERSION))).not.toThrow();
  });

  it('refuses a file changed by one byte', () => {
    const pinned = engineHashes(dir, VERSION);
    writeFileSync(join(dir, `schema-engine-${ENGINE_TARGETS[1]}`), `${ENGINE_TARGETS[1]}!`);
    expect(() => checkEngines(dir, VERSION, pinned)).toThrow(/isn't the pinned one/);
  });

  it('refuses another engine version until it is pinned', () => {
    const pinned = engineHashes(dir, 'older');
    expect(() => checkEngines(dir, VERSION, pinned)).toThrow(/release:engines/);
  });

  it('refuses a missing engine', () => {
    const pinned = engineHashes(dir, VERSION);
    rmSync(join(dir, `schema-engine-${ENGINE_TARGETS[0]}`));
    expect(() => checkEngines(dir, VERSION, pinned)).toThrow(/missing/);
  });

  it('pins every target the release builds, for the Prisma the server uses', () => {
    const pinned = JSON.parse(
      readFileSync(new URL('../prisma-engines.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    const { enginesVersion } = createRequire(import.meta.url)('@prisma/engines-version') as {
      enginesVersion: string;
    };
    expect(pinned.version).toBe(enginesVersion);
    for (const target of ENGINE_TARGETS) expect(pinned[target]).toMatch(/^[0-9a-f]{64}$/);
  });
});
