import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import type {
  Container,
  ContainerHealth,
  ContainersSnapshot,
  ContainerState,
} from '@homelab/shared';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTableImports } from '@ui/table';
import { formatBytes, formatDuration, formatPercent } from '../format/format';
import { ContainerActions } from './container-actions';

const STATE_LABELS: Record<ContainerState, string> = {
  running: 'Running',
  created: 'Created',
  restarting: 'Restarting',
  paused: 'Paused',
  removing: 'Removing',
  exited: 'Stopped',
  dead: 'Dead',
};

const STATE_DOTS: Record<ContainerState, string> = {
  running: 'bg-emerald-500',
  created: 'bg-muted-foreground',
  restarting: 'bg-amber-500',
  paused: 'bg-amber-500',
  removing: 'bg-muted-foreground',
  exited: 'bg-muted-foreground',
  dead: 'bg-destructive',
};

const HEALTH_LABELS: Record<Exclude<ContainerHealth, 'none'>, string> = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  starting: 'Starting',
};

interface Row {
  id: string;
  name: string;
  image: string;
  stateLabel: string;
  stateDot: string;
  health: { label: string; problem: boolean } | null;
  cpu: string;
  memory: string;
  network: string;
  disk: string;
  uptime: string;
  ports: string;
}

/**
 * Every container with its state, health and live resource use, and an actions menu per
 * container. A table from large screens up; a list of cards below, so nothing scrolls sideways on
 * phones. Shared by the dashboard and the Containers page.
 */
@Component({
  selector: 'app-containers-table',
  imports: [
    ContainerActions,
    HlmBadgeImports,
    HlmCardImports,
    HlmSkeleton,
    HlmTableImports,
    NgTemplateOutlet,
  ],
  template: `
    <section hlmCard aria-labelledby="containers-title">
      <div hlmCardHeader>
        <h2 hlmCardTitle id="containers-title">Containers</h2>
        <p hlmCardDescription>{{ summary() }}</p>
      </div>
      <div hlmCardContent>
        @if (containers() === null) {
          <div class="grid gap-2" role="status" aria-label="Loading containers">
            <hlm-skeleton class="h-8 w-full" />
            <hlm-skeleton class="h-8 w-full" />
          </div>
        } @else if (!dockerAvailable()) {
          <div role="alert" class="rounded-lg border border-dashed p-4 text-sm">
            <p class="font-medium">Docker isn't reachable</p>
            <p class="mt-1 text-muted-foreground">
              Container information is unavailable right now. Make sure Docker is running; this page
              updates by itself once it is.
            </p>
          </div>
        } @else if (rows().length === 0) {
          <p class="text-sm text-muted-foreground">No containers yet.</p>
        } @else {
          <!-- Large screens: a table. -->
          <div hlmTableContainer class="hidden lg:block">
            <table hlmTable>
              <thead hlmTHead>
                <tr hlmTr>
                  <th hlmTh scope="col">Name</th>
                  <th hlmTh scope="col">State</th>
                  <th hlmTh scope="col" class="text-end">CPU</th>
                  <th hlmTh scope="col" class="text-end">Memory</th>
                  <th hlmTh scope="col" class="text-end">Network</th>
                  <th hlmTh scope="col" class="text-end">Disk I/O</th>
                  <th hlmTh scope="col">Up for</th>
                  <th hlmTh scope="col">Ports</th>
                  <th hlmTh scope="col" class="w-12"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody hlmTBody>
                @for (row of rows(); track row.id) {
                  <tr hlmTr>
                    <th hlmTd scope="row" class="font-normal">
                      <span class="block font-medium"
                        >{{ row.name }}<span class="sr-only">, </span></span
                      >
                      <span
                        class="block max-w-64 truncate text-xs text-muted-foreground"
                        [title]="row.image"
                        >{{ row.image }}</span
                      >
                    </th>
                    <td hlmTd>
                      <ng-container *ngTemplateOutlet="state; context: { $implicit: row }" />
                    </td>
                    <td hlmTd class="text-end tabular-nums">{{ row.cpu }}</td>
                    <td hlmTd class="text-end tabular-nums">{{ row.memory }}</td>
                    <td hlmTd class="text-end tabular-nums">{{ row.network }}</td>
                    <td hlmTd class="text-end tabular-nums">{{ row.disk }}</td>
                    <td hlmTd>{{ row.uptime }}</td>
                    <td hlmTd class="text-xs">{{ row.ports }}</td>
                    <td hlmTd class="text-end">
                      <app-container-actions [name]="row.name" />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <!-- Phones and tablets: one card per container. -->
          <ul class="grid gap-3 lg:hidden">
            @for (row of rows(); track row.id) {
              <li class="grid gap-2 rounded-lg border p-3">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <span class="min-w-0">
                    <span class="block font-medium break-all"
                      >{{ row.name }}<span class="sr-only">, </span></span
                    >
                    <span class="block text-xs text-muted-foreground break-all">{{
                      row.image
                    }}</span>
                  </span>
                  <span class="flex items-center gap-1">
                    <ng-container *ngTemplateOutlet="state; context: { $implicit: row }" />
                    <app-container-actions [name]="row.name" />
                  </span>
                </div>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                  <div>
                    <dt class="text-muted-foreground">CPU</dt>
                    <dd class="tabular-nums">{{ row.cpu }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Memory</dt>
                    <dd class="tabular-nums">{{ row.memory }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Up for</dt>
                    <dd>{{ row.uptime }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Network</dt>
                    <dd class="tabular-nums">{{ row.network }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Disk I/O</dt>
                    <dd class="tabular-nums">{{ row.disk }}</dd>
                  </div>
                  <div>
                    <dt class="text-muted-foreground">Ports</dt>
                    <dd class="break-all">{{ row.ports }}</dd>
                  </div>
                </dl>
              </li>
            }
          </ul>
        }
      </div>
    </section>

    <ng-template #state let-row>
      <span class="flex flex-wrap items-center gap-2">
        <span class="flex items-center gap-1.5 text-sm">
          <span
            class="size-2 shrink-0 rounded-full"
            [class]="row.stateDot"
            aria-hidden="true"
          ></span>
          {{ row.stateLabel }}
        </span>
        @if (row.health; as health) {
          <span hlmBadge [variant]="health.problem ? 'destructive' : 'outline'">{{
            health.label
          }}</span>
        }
      </span>
    </ng-template>
  `,
})
export class ContainersTable {
  /** Null until the first snapshot. */
  readonly containers = input.required<ContainersSnapshot | null>();
  /**
   * "Now" for uptimes (the dashboard passes the latest system sample's time), so they move with
   * the live data. Without it: the newest stats frame's time, else this device's clock.
   */
  readonly now = input<number | null>(null);

  private readonly clock = computed(() => {
    const given = this.now();
    if (given !== null) return given;
    const snapshot = this.containers();
    const times = snapshot?.dockerAvailable
      ? snapshot.containers.flatMap((c) => (c.stats ? [c.stats.at] : []))
      : [];
    return times.length > 0 ? Math.max(...times) : Date.now();
  });

  protected readonly dockerAvailable = computed(() => this.containers()?.dockerAvailable ?? false);

  protected readonly rows = computed<Row[]>(() => {
    const snapshot = this.containers();
    if (!snapshot?.dockerAvailable) return [];
    return snapshot.containers.map((container) => this.toRow(container));
  });

  protected readonly summary = computed(() => {
    const snapshot = this.containers();
    if (!snapshot) return 'Loading…';
    if (!snapshot.dockerAvailable) return 'Docker not reachable';
    const running = snapshot.containers.filter((c) => c.state === 'running').length;
    return `${running} of ${snapshot.containers.length} running`;
  });

  private toRow(container: Container): Row {
    const { stats } = container;
    const startedAt = container.startedAt ? Date.parse(container.startedAt) : null;
    return {
      id: container.id,
      name: container.name,
      image: container.image,
      stateLabel: STATE_LABELS[container.state],
      stateDot: STATE_DOTS[container.state],
      health:
        container.health === 'none'
          ? null
          : { label: HEALTH_LABELS[container.health], problem: container.health === 'unhealthy' },
      cpu: stats ? formatPercent(stats.cpuPercent) : '—',
      memory: stats
        ? `${formatBytes(stats.memoryUsedBytes)} / ${formatBytes(stats.memoryLimitBytes)}`
        : '—',
      network: stats
        ? `${formatBytes(stats.netRxBytes)} in, ${formatBytes(stats.netTxBytes)} out`
        : '—',
      disk: stats
        ? `${formatBytes(stats.blockReadBytes)} read, ${formatBytes(stats.blockWriteBytes)} written`
        : '—',
      uptime:
        container.state === 'running' && startedAt !== null
          ? formatDuration((this.clock() - startedAt) / 1000)
          : '—',
      ports:
        container.ports
          .map((p) =>
            p.publicPort
              ? `${p.publicPort} → ${p.privatePort}/${p.protocol}`
              : `${p.privatePort}/${p.protocol}`,
          )
          .join(', ') || '—',
    };
  }
}
