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
 * One group per app (as the Apps page sees them), by name, the containers of no app last. Never
 * by state: a group moving while someone reaches for a row's menu would put the wrong row there.
 */
export function groupByApp(containers: readonly Container[]): ContainerGroup[] {
  const apps = new Map(appsFromContainers(containers).map((app) => [app.name, app]));
  const byApp = new Map<string | null, Container[]>();
  for (const container of containers) {
    const project = container.composeProject;
    const key = project !== null && apps.has(project) ? project : null;
    const own = byApp.get(key);
    if (own) own.push(container);
    else byApp.set(key, [container]);
  }
  const groups = [...byApp].map(([name, own]): ContainerGroup => ({
    app: name === null ? null : { name, templateId: apps.get(name)!.template?.id ?? null },
    containers: [...own].sort((a, b) => a.name.localeCompare(b.name)),
    running: own.filter((c) => c.state === 'running').length,
  }));
  return groups.sort(
    (a, b) =>
      Number(a.app === null) - Number(b.app === null) ||
      (a.app?.name ?? '').localeCompare(b.app?.name ?? ''),
  );
}
