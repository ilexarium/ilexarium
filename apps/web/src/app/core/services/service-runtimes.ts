import { type Container, type InstalledService, serviceProject } from '@laris/shared';
import type { ServiceRuntime } from './services.model';

/** What each installed service's containers (Compose project `hl-<id>`) are doing, by catalog id. */
export function serviceRuntimes(
  services: InstalledService[],
  containers: Container[],
): Map<string, ServiceRuntime> {
  const runtimes = new Map<string, ServiceRuntime>();
  for (const service of services) {
    const own = serviceContainers(service, containers);
    const running = own.filter((c) => c.state === 'running');
    runtimes.set(
      service.catalogId,
      own.some((c) => c.health === 'unhealthy')
        ? 'unhealthy'
        : running.length === 0
          ? 'stopped'
          : running.length < own.length
            ? 'partial'
            : 'running',
    );
  }
  return runtimes;
}

export function serviceContainers(service: InstalledService, containers: Container[]): Container[] {
  const project = serviceProject(service.catalogId);
  return containers.filter((c) => c.composeProject === project);
}

/** The web page of the service: same host as this app, its own port. Plain HTTP (inside your network). */
export function serviceUrl(service: InstalledService, hostname: string): string | null {
  if (service.status !== 'installed' || service.webPort === null) return null;
  return `http://${hostname}:${service.webPort}/`;
}
