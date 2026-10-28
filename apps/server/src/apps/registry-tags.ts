import { Injectable, Logger } from '@nestjs/common';
import type { LookupFunction } from 'node:net';
import { Agent, fetch, type Response } from 'undici';
import { checkTarget } from '../alerts/safe-address.js';
import {
  DOCKER_HUB,
  REGISTRY_CACHE_ENTRIES,
  REGISTRY_CACHE_MS,
  REGISTRY_MAX_BYTES,
  REGISTRY_PAGES,
  REGISTRY_TIMEOUT_MS,
} from './apps.constants.js';
import { splitImage } from './compose-fields.js';
import { orderVersions } from './versions.js';

/** Where an image's tags are listed: its registry and repository (Docker Hub's own rules). */
export function registryOf(image: string): { host: string; repository: string } | null {
  const { image: name } = splitImage(image.trim());
  if (!/^[a-z0-9][a-z0-9._/:-]*$/.test(name) || name.includes('$')) return null;
  const parts = name.split('/');
  const first = parts[0];
  const hosted =
    parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const host = hosted ? first : DOCKER_HUB;
  const rest = hosted ? parts.slice(1) : parts;
  const repository = !hosted && rest.length === 1 ? `library/${rest[0]}` : rest.join('/');
  if (host === 'docker.io' || host === 'index.docker.io') {
    return {
      host: DOCKER_HUB,
      repository: repository.includes('/') ? repository : `library/${repository}`,
    };
  }
  return repository ? { host, repository } : null;
}

/**
 * "Show available versions": an image's tags from its registry (the OCI distribution API's
 * `/v2/<repository>/tags/list`), anonymously — a registry that wants a sign-in has no list here.
 * Only on request, never in the background. HTTPS only, to public addresses only (checked after
 * resolving, connected to as checked), size and time limited, cached a few minutes.
 */
@Injectable()
export class RegistryTags {
  private readonly logger = new Logger(RegistryTags.name);
  private readonly cache = new Map<string, { at: number; versions: string[] | null }>();

  async versions(image: string): Promise<string[] | null> {
    const where = registryOf(image);
    if (!where) return null;
    const key = `${where.host}/${where.repository}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < REGISTRY_CACHE_MS) return cached.versions;
    let versions: string[] | null;
    try {
      versions = orderVersions(await this.tags(where.host, where.repository));
    } catch (error) {
      this.logger.warn(`No versions for ${key}: ${(error as Error).message}`);
      versions = null;
    }
    this.cache.set(key, { at: Date.now(), versions });
    while (this.cache.size > REGISTRY_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return versions;
  }

  private async tags(host: string, repository: string): Promise<string[]> {
    let url: string | null = `https://${host}/v2/${repository}/tags/list?n=1000`;
    let token: string | null = null;
    const tags: string[] = [];
    for (let page = 0; url && page < REGISTRY_PAGES; page++) {
      let response = await this.get(url, token);
      if (response.status === 401 && token === null) {
        token = await this.token(response.headers.get('www-authenticate'), host);
        response = await this.get(url, token);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = response.body as { tags?: unknown };
      if (Array.isArray(body.tags)) {
        tags.push(
          ...body.tags.filter((t): t is string => typeof t === 'string' && t.length <= 128),
        );
      }
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
      url = next ? new URL(next, `https://${host}`).toString() : null;
      if (url && new URL(url).host !== host) url = null;
    }
    return tags;
  }

  /** An anonymous token, from the realm the registry names (`Bearer realm=…,service=…,scope=…`). */
  private async token(challenge: string | null, host: string): Promise<string> {
    const field = (name: string) => new RegExp(`${name}="([^"]*)"`, 'i').exec(challenge ?? '')?.[1];
    const realm = field('realm');
    if (!challenge?.toLowerCase().startsWith('bearer') || !realm) {
      throw new Error(`${host} wants a sign-in`);
    }
    const url = new URL(realm);
    if (url.protocol !== 'https:') throw new Error('the token address is not HTTPS');
    for (const name of ['service', 'scope']) {
      const value = field(name);
      if (value) url.searchParams.set(name, value);
    }
    const response = await this.get(url.toString(), null);
    if (!response.ok) throw new Error(`token: HTTP ${response.status}`);
    const body = response.body as { token?: unknown; access_token?: unknown };
    const token = body.token ?? body.access_token;
    if (typeof token !== 'string' || token.length > 16 * 1024) throw new Error('no token');
    return token;
  }

  /** One GET to a checked public address, connected to as checked; its body read whole (JSON). */
  protected async get(url: string, token: string | null): Promise<Answer> {
    const { hostname, port } = new URL(url);
    const target = await checkTarget(hostname, Number(port || 443), {
      reservedPorts: [],
      plain: false,
    });
    if (target.local) throw new Error(`${hostname} is not a public address`);
    const pinned: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    const dispatcher = new Agent({ connect: { lookup: pinned } });
    try {
      const response = await fetch(url, {
        dispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      });
      // Registries redirect blob downloads, never tag lists: a redirect is refused.
      if (response.status >= 300 && response.status < 400) throw new Error('redirected');
      const body = response.ok ? await readJson(response) : (await response.body?.cancel(), null);
      return { status: response.status, ok: response.ok, headers: response.headers, body };
    } finally {
      void dispatcher.destroy().catch(() => undefined);
    }
  }
}

interface Answer {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > REGISTRY_MAX_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
