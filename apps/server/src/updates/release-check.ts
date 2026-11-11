import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';
import type { UpdateCheckError } from '@ilex/shared';
import { Agent, fetch } from 'undici';
import { parseReleaseKey, type ReleaseKey, verifyRelease } from './release-signature.js';
import { parseManifest } from './release-manifest.js';
import { UpdatePlaces } from './update-places.js';
import {
  CHECK_TIMEOUT_MS,
  DEV_RELEASE_URL,
  MANIFEST_MAX_BYTES,
  MAX_REDIRECTS,
  NOTES_MAX_BYTES,
  REDIRECTS,
  RELEASE_URL,
} from './updates.constants.js';
import type { ReleaseManifest } from './updates.model.js';

export interface ReleaseSource {
  url: string;
  key: ReleaseKey;
}

export type CheckResult =
  | { ok: true; newest: ReleaseManifest; notes: string | null }
  | { ok: false; error: UpdateCheckError };

class Unreachable extends Error {}

/**
 * The newest release in the machine's release folder: the
 * `latest` manifest and its signature, checked against the installed key — a fake notice is
 * refused. Unprivileged, read-only; the address and key are the installer's root-owned files.
 */
@Injectable()
export class ReleaseCheck {
  constructor(private readonly updatePlaces: UpdatePlaces) {}

  /** Where updates come from, or null: a release built without RELEASE_URL, or files missing. */
  async source(): Promise<ReleaseSource | null> {
    const dir = this.updatePlaces.settingsDir;
    try {
      const [env, pub] = await Promise.all([
        readFile(join(dir, 'release.env'), 'utf8'),
        readFile(join(dir, 'release.pub'), 'utf8'),
      ]);
      const url = /^RELEASE_URL=(.*)$/m.exec(env)?.[1] ?? '';
      const allowed =
        RELEASE_URL.test(url) || (this.updatePlaces.development && DEV_RELEASE_URL.test(url));
      const key = parseReleaseKey(pub);
      return allowed && key ? { url, key } : null;
    } catch {
      return null;
    }
  }

  async newest(source: ReleaseSource): Promise<CheckResult> {
    // The machine's own trusted certificates too (like ilex-update): a release folder behind the
    // owner's own certificate authority works like one with a public certificate.
    const dispatcher = new Agent({
      connect: { ca: [...getCACertificates('bundled'), ...getCACertificates('system')] },
    });
    try {
      const latest = `${source.url}/latest/download`;
      let manifestBytes: Buffer;
      let signature: Buffer;
      try {
        [manifestBytes, signature] = await Promise.all([
          this.fetchSmall(`${latest}/latest.json`, MANIFEST_MAX_BYTES, dispatcher),
          this.fetchSmall(`${latest}/latest.json.minisig`, MANIFEST_MAX_BYTES, dispatcher),
        ]);
      } catch {
        return { ok: false, error: 'unreachable' };
      }
      if (!verifyRelease(source.key, signature.toString('utf8'), manifestBytes)) {
        return { ok: false, error: 'bad_signature' };
      }
      const newest = parseManifest(manifestBytes.toString('utf8'));
      if (!newest) return { ok: false, error: 'bad_manifest' };
      return { ok: true, newest, notes: await this.notes(source, newest, dispatcher) };
    } finally {
      void dispatcher.destroy().catch(() => undefined);
    }
  }

  // The notes aren't covered by the signature: plain text only, shown as text, never as HTML.
  private async notes(
    source: ReleaseSource,
    manifest: ReleaseManifest,
    dispatcher: Agent,
  ): Promise<string | null> {
    if (!manifest.notes) return null;
    try {
      const url = `${source.url}/download/v${manifest.version}/${manifest.notes}`;
      const text = (await this.fetchSmall(url, NOTES_MAX_BYTES, dispatcher)).toString('utf8');
      return text.replace(/[^\P{Cc}\n\t]/gu, '').trim() || null;
    } catch {
      return null;
    }
  }

  private allowed(url: URL): boolean {
    return (
      url.protocol === 'https:' ||
      (this.updatePlaces.development && url.protocol === 'http:' && url.hostname === '127.0.0.1')
    );
  }

  private async fetchSmall(address: string, maxBytes: number, dispatcher: Agent): Promise<Buffer> {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    let url = new URL(address);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!this.allowed(url)) throw new Unreachable('not https');
      const response = await fetch(url, { redirect: 'manual', signal, dispatcher });
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Unreachable('a redirect without a location');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Unreachable(`HTTP ${response.status}`);
      }
      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) {
          await response.body.cancel().catch(() => undefined);
          throw new Unreachable('too large');
        }
        parts.push(chunk);
      }
      return Buffer.concat(parts);
    }
    throw new Unreachable('too many redirects');
  }
}
