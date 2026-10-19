// compose/policy.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// The policy, on Compose's own rendered config (one normalised form for everything).

import type { CheckedValues } from './values.mts';
import { Refusal } from '../lib/output.mts';

export const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

export const RESERVED_LABEL = /^(homelab\.|com\.docker\.compose\.)/;

export const SERVICE_KEYS = new Set([
  'image',
  'command',
  'entrypoint',
  'environment',
  'user',
  'working_dir',
  'ports',
  'expose',
  'volumes',
  'tmpfs',
  'depends_on',
  'restart',
  'healthcheck',
  'logging',
  'labels',
  'shm_size',
  'init',
  'read_only',
  'stop_grace_period',
  'stop_signal',
  'mem_limit',
  'cpus',
  'pids_limit',
  'ulimits',
  'networks',
]);

export function checkPolicy(config: unknown, project: string, values: CheckedValues): void {
  const fail = (where: string, what: string): never => {
    throw new Refusal('policy_violation', `${where}: ${what}`, 4);
  };
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(config)) return fail('config', 'not an object');

  for (const key of Object.keys(config)) {
    if (!['name', 'services', 'volumes', 'networks'].includes(key)) fail(key, 'not allowed');
  }
  if (config['name'] !== project) fail('name', 'unexpected project name');

  const networks = config['networks'] ?? {};
  if (!isObject(networks)) return fail('networks', 'not a mapping');
  for (const [name, network] of Object.entries(networks)) {
    if (name !== 'default' || !isObject(network))
      fail(`networks.${name}`, 'only the default network');
    for (const [key, value] of Object.entries(network as Record<string, unknown>)) {
      const plain =
        (key === 'name' && value === `${project}_default`) ||
        (key === 'ipam' && isObject(value) && Object.keys(value).length === 0);
      if (!plain) fail(`networks.${name}.${key}`, 'not allowed');
    }
  }

  const volumes = config['volumes'] ?? {};
  if (!isObject(volumes)) return fail('volumes', 'not a mapping');
  for (const [name, volume] of Object.entries(volumes)) {
    const keys = isObject(volume) ? Object.keys(volume) : ['?'];
    if (
      keys.some((k) => k !== 'name') ||
      (volume as { name?: unknown }).name !== `${project}_${name}`
    ) {
      fail(`volumes.${name}`, 'named volumes take no options');
    }
  }

  const services = config['services'];
  if (!isObject(services) || Object.keys(services).length === 0) return fail('services', 'none');
  for (const [name, service] of Object.entries(services)) {
    const at = `services.${name}`;
    if (!isObject(service)) return fail(at, 'not a mapping');
    for (const key of Object.keys(service))
      if (!SERVICE_KEYS.has(key)) fail(`${at}.${key}`, 'not allowed');

    if (typeof service['image'] !== 'string' || !PINNED_IMAGE.test(service['image'])) {
      fail(`${at}.image`, 'not pinned by digest');
    }
    if (service['restart'] !== 'unless-stopped') fail(`${at}.restart`, 'must be unless-stopped');
    const logging = service['logging'];
    const options = isObject(logging) ? logging['options'] : undefined;
    if (
      !isObject(logging) ||
      !['json-file', 'local'].includes(String(logging['driver'])) ||
      !isObject(options) ||
      !options['max-size']
    ) {
      fail(`${at}.logging`, 'no log rotation');
    }
    const serviceNetworks = service['networks'];
    if (
      serviceNetworks !== undefined &&
      !(isObject(serviceNetworks) && Object.keys(serviceNetworks).every((n) => n === 'default'))
    ) {
      fail(`${at}.networks`, 'only the default network');
    }

    for (const port of asArray(service['ports'], `${at}.ports`, fail)) {
      if (!isObject(port)) return fail(`${at}.ports`, 'not a mapping');
      const keysOk = Object.keys(port).every((k) =>
        ['mode', 'target', 'published', 'protocol', 'host_ip'].includes(k),
      );
      // On every address, or on loopback only (a service without its own sign-in); no other address.
      const addressOk = port['host_ip'] === undefined || port['host_ip'] === '127.0.0.1';
      if (
        !keysOk ||
        !addressOk ||
        port['mode'] !== 'ingress' ||
        !values.ports.has(String(port['published'])) ||
        !['tcp', 'udp'].includes(String(port['protocol']))
      ) {
        fail(`${at}.ports`, `port ${String(port['published'])} is not a validated port field`);
      }
    }

    for (const volume of asArray(service['volumes'], `${at}.volumes`, fail)) {
      if (!isObject(volume)) return fail(`${at}.volumes`, 'not a mapping');
      for (const key of Object.keys(volume)) {
        // Compose writes an empty `volume: {}` for named volumes; options there are refused.
        const emptyVolumeOptions =
          key === 'volume' &&
          volume['type'] === 'volume' &&
          isObject(volume['volume']) &&
          Object.keys(volume['volume']).length === 0;
        if (!['type', 'source', 'target', 'read_only'].includes(key) && !emptyVolumeOptions) {
          fail(`${at}.volumes.${key}`, 'not allowed');
        }
      }
      const source = String(volume['source']);
      if (volume['type'] === 'volume') {
        if (!Object.hasOwn(volumes, source))
          fail(`${at}.volumes`, `${source} is not a volume of this project`);
      } else if (volume['type'] === 'bind') {
        const access = values.folders.get(source);
        if (!access) fail(`${at}.volumes`, `${source} is not a validated folder field`);
        if (access === 'read' && volume['read_only'] !== true)
          fail(`${at}.volumes`, `${source} must be read-only`);
      } else {
        fail(`${at}.volumes`, `type ${String(volume['type'])} not allowed`);
      }
    }

    const labels = service['labels'];
    const labelKeys = isObject(labels) ? Object.keys(labels) : [];
    if (labels !== undefined && !isObject(labels)) fail(`${at}.labels`, 'not a mapping');
    for (const label of labelKeys)
      if (RESERVED_LABEL.test(label)) fail(`${at}.labels`, `reserved label ${label}`);
  }
}

export function asArray(
  value: unknown,
  where: string,
  fail: (w: string, m: string) => never,
): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail(where, 'not a list');
  return value;
}
