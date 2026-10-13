import type { CatalogMeta } from '@homelab/shared';

/**
 * The Compose policy for catalog recipes, checked on the template itself (placeholders not yet
 * filled in). An **allow-list**: a service may use only the keys below, in the forms below —
 * anything Compose adds later, or nobody thought of, is refused. The root wrapper checks the same
 * rules again, independently, on `docker compose config` output (docs/plans/service_deploys.md,
 * decision 6). Returns every violation found, as text for the startup error and the tests.
 */
export function checkComposePolicy(template: unknown, meta: CatalogMeta): string[] {
  const problems: string[] = [];
  const fail = (where: string, what: string) => problems.push(`${where}: ${what}`);
  if (!isObject(template)) return ['the file is not a Compose mapping'];

  for (const key of Object.keys(template)) {
    if (key !== 'services' && key !== 'volumes') fail(key, 'top-level key not allowed');
  }
  const volumes = template['volumes'] ?? {};
  if (!isObject(volumes)) {
    fail('volumes', 'must be a mapping');
  } else {
    for (const [name, definition] of Object.entries(volumes)) {
      // Options could bind-mount a host folder (driver_opts: o=bind, device=/etc) or reach outside.
      if (definition !== null && !(isObject(definition) && Object.keys(definition).length === 0)) {
        fail(`volumes.${name}`, 'named volumes take no options');
      }
    }
  }
  const namedVolumes = new Set(isObject(volumes) ? Object.keys(volumes) : []);

  const services = template['services'];
  if (!isObject(services) || Object.keys(services).length === 0) {
    fail('services', 'at least one service');
    return problems;
  }
  const serviceNames = new Set(Object.keys(services));
  const portKeys = new Set(meta.fields.filter((f) => f.type === 'port').map((f) => f.key));
  const pathAccess = new Map(
    meta.fields.flatMap((f) => (f.type === 'path' ? [[f.key, f.access] as const] : [])),
  );
  const usedPorts = new Set<string>();
  const usedPaths = new Set<string>();

  for (const [name, service] of Object.entries(services)) {
    const at = `services.${name}`;
    if (!isObject(service)) {
      fail(at, 'must be a mapping');
      continue;
    }
    for (const key of Object.keys(service)) {
      if (!SERVICE_KEYS.has(key)) fail(`${at}.${key}`, 'not allowed');
    }

    for (const key of ['ports', 'volumes', 'tmpfs', 'expose'] as const) {
      if (key in service && !Array.isArray(service[key])) fail(`${at}.${key}`, 'must be a list');
    }

    const image = service['image'];
    if (typeof image !== 'string' || !PINNED_IMAGE.test(image)) {
      fail(`${at}.image`, 'must be pinned by digest (name:tag@sha256:…)');
    }
    if (service['restart'] !== 'unless-stopped') fail(`${at}.restart`, 'must be unless-stopped');

    const logging = service['logging'];
    const options = isObject(logging) ? logging['options'] : undefined;
    if (
      !isObject(logging) ||
      !LOG_DRIVERS.has(String(logging['driver'])) ||
      !isObject(options) ||
      !options['max-size']
    ) {
      fail(`${at}.logging`, 'json-file or local, with max-size (log rotation)');
    }

    for (const [i, port] of asList(service['ports']).entries()) {
      const key = typeof port === 'string' ? PORT_ENTRY.exec(port)?.[1] : undefined;
      if (!key || !portKeys.has(key)) {
        fail(`${at}.ports[${i}]`, "only '${PORT_FIELD}:<container port>' with a declared port");
      } else {
        usedPorts.add(key);
      }
    }

    for (const [i, volume] of asList(service['volumes']).entries()) {
      const where = `${at}.volumes[${i}]`;
      if (typeof volume === 'string') {
        // Short syntax only for named volumes: "<name>:/target".
        const [source, target, ...rest] = volume.split(':');
        if (!namedVolumes.has(source) || !target?.startsWith('/') || rest.length > 0) {
          fail(where, 'short syntax only as <named volume>:/target; folders in long syntax');
        }
        continue;
      }
      if (!isObject(volume)) {
        fail(where, 'must be a string or a mapping');
        continue;
      }
      for (const key of Object.keys(volume)) {
        if (!VOLUME_KEYS.has(key)) fail(`${where}.${key}`, 'not allowed');
      }
      const source = typeof volume['source'] === 'string' ? volume['source'] : '';
      if (volume['type'] === 'volume') {
        if (!namedVolumes.has(source)) fail(where, 'not a volume declared in this file');
      } else if (volume['type'] === 'bind') {
        const key = PLACEHOLDER_ONLY.exec(source)?.[1];
        const access = key ? pathAccess.get(key) : undefined;
        if (!key || !access) {
          fail(where, 'a bind mount source must be exactly ${PATH_FIELD}');
        } else {
          usedPaths.add(key);
          if (access === 'read' && volume['read_only'] !== true) {
            fail(where, `${key} is read-only (access "read"): set read_only: true`);
          }
        }
      } else {
        fail(where, 'type must be volume or bind');
      }
    }

    const labels = service['labels'];
    const labelKeys = isObject(labels)
      ? Object.keys(labels)
      : asList(labels).map((label) => String(label).split('=')[0]);
    for (const label of labelKeys) {
      if (RESERVED_LABEL.test(label)) fail(`${at}.labels.${label}`, 'reserved label');
    }

    const dependsOn = service['depends_on'];
    const needs = isObject(dependsOn) ? Object.keys(dependsOn) : asList(dependsOn).map(String);
    for (const other of needs) {
      if (!serviceNames.has(other)) fail(`${at}.depends_on`, `unknown service ${other}`);
    }
  }

  for (const key of portKeys) if (!usedPorts.has(key)) fail(key, 'port field never published');
  for (const key of pathAccess.keys()) if (!usedPaths.has(key)) fail(key, 'folder never mounted');
  return problems;
}

/**
 * The template's `$` uses: each must be `$$` (a literal "$") or exactly `${KEY}` of a declared
 * field — no defaults (`${X:-y}`), no `$NAME`, nothing from the environment.
 */
export function checkPlaceholders(templateText: string, meta: CatalogMeta): string[] {
  const problems: string[] = [];
  const keys = new Set(meta.fields.map((field) => field.key));
  const used = new Set<string>();
  for (const match of templateText.matchAll(/\$(\$|\{[^}]*\}|[^{$]?)/g)) {
    if (match[1] === '$') continue;
    const key = /^\{([A-Z][A-Z0-9_]*)\}$/.exec(match[1])?.[1];
    if (!key) {
      problems.push(`"${match[0]}": only \${KEY} of a declared field, or $$`);
    } else if (!keys.has(key)) {
      problems.push(`\${${key}}: not a declared field`);
    } else {
      used.add(key);
    }
  }
  for (const key of keys) if (!used.has(key)) problems.push(`${key}: declared but never used`);
  return problems;
}

/** Keys a service may use. Everything else is refused (privileged, cap_add, devices, network_mode, volumes_from, …). */
const SERVICE_KEYS = new Set([
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
]);
const VOLUME_KEYS = new Set(['type', 'source', 'target', 'read_only']);
const LOG_DRIVERS = new Set(['json-file', 'local']);
/** name[:tag]@sha256:<64 hex> */
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const PORT_ENTRY = /^\$\{([A-Z][A-Z0-9_]*)\}:[0-9]{1,5}(?:\/(?:tcp|udp))?$/;
const PLACEHOLDER_ONLY = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
/** Ours, and Compose's own (a recipe must not pose as another project). */
const RESERVED_LABEL = /^(homelab\.|com\.docker\.compose\.)/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
