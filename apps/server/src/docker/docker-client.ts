import type { ConfigService } from '@nestjs/config';
import Dockerode from 'dockerode';
import type { Env } from '../config/env.schema.js';

/** A Dockerode client for the socket proxy at `DOCKER_HOST` (plain HTTP, never the socket). */
export function createDockerClient(config: ConfigService<Env, true>): Dockerode {
  const url = new URL(config.get('DOCKER_HOST', { infer: true }));
  return new Dockerode({
    protocol: 'http',
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'), // IPv6 literal without brackets
    port: Number(url.port || 2375),
  });
}
