import { HIDDEN_TAG, NOISE_TAG, VERSIONS_SHOWN } from './apps.constants.js';

/** A tag's numbers (`v1.2.3-alpine` → [1, 2, 3]) and what follows them; null for other tags. */
function parts(tag: string): { numbers: number[]; suffix: string } | null {
  const match = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(tag);
  if (!match) return null;
  return { numbers: match[1].split('.').map(Number), suffix: match[2] };
}

/**
 * The versions worth offering, newest first: tags that are versions, released (no `latest`,
 * nightlies, release candidates or betas), the plainest first among equal numbers (`1.2` before
 * `1.2-alpine`). Wider lines (`1`, `1.2`) stay: following one brings patches with nothing to change.
 */
export function orderVersions(tags: readonly string[]): string[] {
  const kept = tags
    .filter((tag) => !HIDDEN_TAG.test(tag) && !NOISE_TAG.test(tag))
    .map((tag) => ({ tag, parts: parts(tag) }))
    .filter((entry): entry is { tag: string; parts: NonNullable<ReturnType<typeof parts>> } =>
      entry.parts !== null,
    );
  kept.sort((a, b) => {
    const length = Math.max(a.parts.numbers.length, b.parts.numbers.length);
    for (let i = 0; i < length; i++) {
      // A missing number sorts above: `1` is the newest of the 1.x line.
      const x = a.parts.numbers[i] ?? Infinity;
      const y = b.parts.numbers[i] ?? Infinity;
      if (x !== y) return y - x;
    }
    if (a.parts.suffix !== b.parts.suffix) {
      if (a.parts.suffix === '') return -1;
      if (b.parts.suffix === '') return 1;
    }
    return a.tag.localeCompare(b.tag);
  });
  return [...new Set(kept.map((entry) => entry.tag))].slice(0, VERSIONS_SHOWN);
}
