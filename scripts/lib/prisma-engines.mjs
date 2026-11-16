// Prisma's migration engine, which the installer runs as root: downloaded at build time, and
// accepted only if it is byte for byte the one pinned in scripts/prisma-engines.json — Prisma's
// own downloader checks it only against a checksum from the same server.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The CPUs the installer supports (all three distributions ship OpenSSL 3). */
export const ENGINE_TARGETS = ['debian-openssl-3.0.x', 'linux-arm64-openssl-3.0.x'];

const PIN_COMMAND = 'npm run release:engines';

const engineFile = (dir, target) => join(dir, `schema-engine-${target}`);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Downloads the engine for every target into `dir`, for the Prisma version the server uses. */
export async function downloadEngines(root, dir) {
  const require = createRequire(join(root, 'apps/server/package.json'));
  const { download } = require('@prisma/fetch-engine');
  const { enginesVersion } = require('@prisma/engines-version');
  await download({
    binaries: { 'schema-engine': dir },
    binaryTargets: ENGINE_TARGETS,
    version: enginesVersion,
    showProgress: false,
  });
  return enginesVersion;
}

/** What scripts/prisma-engines.json holds: the version and each target's SHA-256. */
export function engineHashes(dir, version) {
  return Object.fromEntries([
    ['version', version],
    ...ENGINE_TARGETS.map((target) => [target, sha256(engineFile(dir, target))]),
  ]);
}

/** Throws unless every engine in `dir` is the pinned one. */
export function checkEngines(dir, version, pinned) {
  if (pinned.version !== version) {
    throw new Error(
      `Prisma's engines are ${version}, but scripts/prisma-engines.json pins ${pinned.version}: ${PIN_COMMAND} (after a Prisma upgrade)`,
    );
  }
  for (const target of ENGINE_TARGETS) {
    const file = engineFile(dir, target);
    if (!existsSync(file)) throw new Error(`Prisma's schema engine for ${target} is missing`);
    const actual = sha256(file);
    if (actual !== pinned[target]) {
      throw new Error(
        `Prisma's schema engine for ${target} isn't the pinned one (sha256 ${actual}, pinned ${pinned[target]}): never released`,
      );
    }
  }
}
