// Where releases come from, the key they're checked with, and what a manifest must say. The app
// checks manifests with its own copy (rules-match-app.spec.ts compares them).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, Paths } from './model.mts';
import { parsePublicKey, type PublicKey } from '../lib/minisign.mts';
import { Refusal } from '../lib/output.mts';
import { assertRootOwned } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

export const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,5})$/;
export const SHA256 = /^[0-9a-f]{64}$/;
/** A plain https:// address: it's written into settings files and joined into URLs. */
export const RELEASE_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~-]+)*$/;
/** Development (tests) also serves releases from this machine over plain HTTP. */
export const DEV_RELEASE_URL = /^http:\/\/127\.0\.0\.1:\d+(\/[A-Za-z0-9._~-]+)*$/;
export const MANIFEST_MAX_BYTES = 4096;
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
const PUBLISHED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function newer(version: string, than: string): boolean {
  const [a, b] = [version, than].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (a![i] !== b![i]) return a![i]! > b![i]!;
  return false;
}

export interface Source {
  url: string;
  key: PublicKey;
}

/** The installed release settings (root-owned): where updates come from and the key. */
export function readSource(paths: Paths): Source {
  const envFile = join(paths.etc, 'release.env');
  const keyFile = join(paths.etc, 'release.pub');
  if (!existsSync(envFile) || !existsSync(keyFile)) {
    throw new Refusal('not_configured', 'this install has no update source', 6);
  }
  if (isRoot) {
    assertRootOwned(envFile);
    assertRootOwned(keyFile);
  }
  const url = /^RELEASE_URL=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1] ?? '';
  if (!RELEASE_URL.test(url) && (isRoot || !DEV_RELEASE_URL.test(url))) {
    throw new Refusal('not_configured', 'no valid RELEASE_URL', 6);
  }
  const key = parsePublicKey(readFileSync(keyFile, 'utf8'));
  if (!key) throw new Refusal('not_configured', 'release.pub is not a public key', 6);
  return { url, key };
}

export function installedVersion(paths: Paths): string {
  const version = readFileSync(join(paths.etc, 'version'), 'utf8').trim();
  if (!VERSION.test(version)) throw new Refusal('setup', 'no installed version', 6);
  return version;
}

/** A manifest's fields, all checked; anything else is refused. */
export function parseManifest(text: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  const known = ['version', 'published', 'archive', 'sha256', 'size', 'notes'];
  if (Object.keys(m).some((key) => !known.includes(key))) return null;
  const { version, published, archive, sha256, size, notes } = m;
  const valid =
    typeof version === 'string' &&
    VERSION.test(version) &&
    typeof published === 'string' &&
    PUBLISHED.test(published) &&
    !Number.isNaN(Date.parse(published)) &&
    // A file name beside the manifest, never an address: the base comes from this machine.
    archive === `laris-${version}.tar.gz` &&
    typeof sha256 === 'string' &&
    SHA256.test(sha256) &&
    Number.isSafeInteger(size) &&
    (size as number) > 0 &&
    (size as number) <= ARCHIVE_MAX_BYTES &&
    (notes === undefined || notes === 'NOTES.md');
  return valid ? (m as unknown as Manifest) : null;
}
