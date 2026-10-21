import type { ConfigService } from '@nestjs/config';
import Dockerode from 'dockerode';
import type { Env } from '../config/env.schema.js';

/**
 * A Dockerode client for the socket proxy at `DOCKER_HOST`: plain HTTP over TCP (development) or
 * the proxy's own Unix socket under /run/laris/ (production) — never Docker's socket.
 */
export function createDockerClient(config: ConfigService<Env, true>): Dockerode {
  const host = config.get('DOCKER_HOST', { infer: true });
  if (host.startsWith('unix://'))
    return new Dockerode({ socketPath: host.slice('unix://'.length) });
  const url = new URL(host);
  return new Dockerode({
    protocol: 'http',
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'), // IPv6 literal without brackets
    port: Number(url.port || 2375),
  });
}
