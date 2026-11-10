import { RELEASE_VERSION_PATTERN } from '@ilex/shared';
import { z } from 'zod';
import type { ReleaseManifest } from './updates.model.js';
import { ARCHIVE_MAX_BYTES } from './updates.constants.js';

// The app's own copy of ilex-update's manifest rules (rules-match-app.spec.ts compares them).
const manifestSchema = z.strictObject({
  version: z.string().regex(RELEASE_VERSION_PATTERN),
  published: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    .refine((value) => !Number.isNaN(Date.parse(value))),
  archive: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive().max(ARCHIVE_MAX_BYTES),
  notes: z.literal('NOTES.md').optional(),
});

export function parseManifest(text: string): ReleaseManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = manifestSchema.safeParse(value);
  // A file name beside the manifest, never an address: the base is this machine's own setting.
  if (!parsed.success || parsed.data.archive !== `ilex-${parsed.data.version}.tar.gz`) return null;
  return parsed.data;
}

export function isNewer(version: string, than: string): boolean {
  const [a, b] = [version, than].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (a![i] !== b![i]) return a![i]! > b![i]!;
  return false;
}
