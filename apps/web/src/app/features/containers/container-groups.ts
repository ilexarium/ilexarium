import { appsFromContainers, type Container } from '@laris/shared';
import type { ContainerGroup } from './containers.model';

/** A plain stop isn't trouble here: unexpected stops are the alerts' job. */
export function needsAttention(container: Pick<Container, 'state' | 'health'>): boolean {
  return (
    container.health === 'unhealthy' ||
    container.state === 'restarting' ||
    container.state === 'dead'
  );
}

/**
 * One group per app (as the Apps page sees them), those needing attention first, then by name;
 * the containers of no app last.
 */
export function groupByApp(containers: readonly Container[]): ContainerGroup[] {
  const apps = new Map(appsFromContainers(containers).map((app) => [app.name, app]));
  const byApp = new Map<string | null, Container[]>();
  for (const container of containers) {
    const project = container.composeProject;
    const key = project !== null && apps.has(project) ? project : null;
    byApp.set(key, [...(byApp.get(key) ?? []), container]);
  }
  const groups = [...byApp].map(([name, own]): ContainerGroup => ({
    app: name === null ? null : { name, templateId: apps.get(name)!.template?.id ?? null },
    containers: [...own].sort((a, b) => a.name.localeCompare(b.name)),
    running: own.filter((c) => c.state === 'running').length,
    attention: own.some(needsAttention),
  }));
  return groups.sort(
    (a, b) =>
      Number(a.app === null) - Number(b.app === null) ||
      Number(b.attention) - Number(a.attention) ||
      (a.app?.name ?? '').localeCompare(b.app?.name ?? ''),
  );
}
