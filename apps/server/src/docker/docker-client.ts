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

/**
 * A request Dockerode has no helper for, or would send differently: `query` becomes the query
 * string (as docker-modem encodes it, which the proxy's exact prune rules match) and nothing goes
 * in the body — Dockerode's own prune helpers would send their options as a JSON body too.
 */
export function dockerRequest<T>(
  docker: Dockerode,
  request: {
    method: 'GET' | 'POST';
    path: string;
    query: Record<string, unknown>;
    statusCodes: Record<number, true | string>;
    abortSignal: AbortSignal;
  },
): Promise<T> {
  const { path, query, ...rest } = request;
  return new Promise((resolve, reject) => {
    (docker.modem as unknown as Modem).dial(
      { ...rest, path: `${path}?`, options: { _query: query, _body: {} } },
      (error, data) => (error ? reject(error) : resolve(data as T)),
    );
  });
}

interface Modem {
  dial(options: object, callback: (error: unknown, data: unknown) => void): void;
}
