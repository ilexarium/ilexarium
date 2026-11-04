// Downloads over HTTPS with Node's own fetch: redirects followed only to https:// addresses (the
// signature decides what's genuine, not the address), never more than the size allowed.

import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { Refusal } from '../lib/output.mts';
import { isRoot } from '../lib/startup.mts';

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// The machine's own trusted certificates too, not only Node's list: a release folder behind the
// owner's own certificate authority works like one with a public certificate.
let trustSet = false;
function trustSystemCertificates(): void {
  if (trustSet) return;
  trustSet = true;
  setDefaultCACertificates([...getCACertificates('bundled'), ...getCACertificates('system')]);
}

function allowed(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return !isRoot && url.protocol === 'http:' && url.hostname === '127.0.0.1';
}

async function open(address: string, signal: AbortSignal): Promise<Response> {
  trustSystemCertificates();
  let url = new URL(address);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(url))
      throw new Refusal('download_failed', `not an https:// address: ${url.origin}`, 5);
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name;
      throw new Refusal('download_failed', `${url.origin}: ${cause}`, 5);
    }
    if (!REDIRECTS.has(response.status)) {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Refusal('download_failed', `${url.pathname}: HTTP ${response.status}`, 5);
      }
      return response;
    }
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Refusal('download_failed', 'a redirect without a location', 5);
    url = new URL(location, url);
  }
  throw new Refusal('download_failed', 'too many redirects', 5);
}

async function* chunks(response: Response, maxBytes: number): AsyncGenerator<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Refusal('too_large', 'larger than allowed', 5);
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Refusal('too_large', 'larger than allowed', 5);
    yield chunk;
  }
}

export async function fetchSmall(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const signal = AbortSignal.timeout(timeoutMs);
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks(await open(url, signal), maxBytes)) parts.push(chunk);
  return Buffer.concat(parts);
}

/** Saves a download to `file` (a new file), returning its size and SHA-256. */
export async function fetchToFile(
  url: string,
  file: string,
  maxBytes: number,
  timeoutMs: number,
  onProgress: (bytes: number) => void,
): Promise<{ size: number; sha256: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await open(url, signal);
  const fd = openSync(file, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of chunks(response, maxBytes)) {
      writeSync(fd, chunk);
      hash.update(chunk);
      size += chunk.length;
      onProgress(size);
    }
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest('hex') };
}
