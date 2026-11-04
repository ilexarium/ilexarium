import { readFileSync } from 'node:fs';

// Laris's version is the root package's (the release writes it there; the server's own stays
// 0.0.0) — the same depth from src/ and dist/.
export const LARIS_VERSION = (
  JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
