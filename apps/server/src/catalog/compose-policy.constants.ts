/** Keys a service may use. Everything else is refused (privileged, cap_add, devices, network_mode, volumes_from, …). */
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
]);
export const VOLUME_KEYS = new Set(['type', 'source', 'target', 'read_only']);
export const LOG_DRIVERS = new Set(['json-file', 'local']);
/** name[:tag]@sha256:<64 hex> */
export const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
/** Published on every address, or on loopback only (a service without its own sign-in, e.g. Ollama). */
export const PORT_ENTRY =
  /^(?:127\.0\.0\.1:)?\$\{([A-Z][A-Z0-9_]*)\}:[0-9]{1,5}(?:\/(?:tcp|udp))?$/;
export const PLACEHOLDER_ONLY = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
/** Ours, and Compose's own (a recipe must not pose as another project). */
export const RESERVED_LABEL = /^(laris\.|com\.docker\.compose\.)/;
