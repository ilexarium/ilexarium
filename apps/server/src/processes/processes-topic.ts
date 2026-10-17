import { Injectable, Logger } from '@nestjs/common';
import type { ProcessesUpdate } from '@homelab/shared';
import {
  defer,
  filter,
  finalize,
  firstValueFrom,
  type Observable,
  ReplaySubject,
  repeat,
  share,
  timer,
} from 'rxjs';
import { DockerService } from '../docker/docker.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import { SystemReader } from '../host/system-reader.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { endRules, processKey, toProcess } from './process-view.js';
import type { ContainerName } from './processes.model.js';

export const PROCESSES_INTERVAL_MS = 2_000;
/** The containers' names are looked up again this often (they rarely change). */
export const CONTAINER_NAMES_MS = 10_000;
const COMPOSE_PREFIX = 'hl-';

/** State of one collecting period: while `updates$` is subscribed. */
interface Run {
  /** CPU ticks of the machine and of each process at the previous reading. */
  previousTotal: number | null;
  previousTicks: Map<string, number>;
  latest: ProcessesUpdate | null;
  first$: ReplaySubject<ProcessesUpdate>;
}

/**
 * The `processes` topic (docs/plans/process_list.md): every process, read from /proc every 2 s —
 * only while someone has the page open. CPU % is each process's share of the whole machine
 * between two readings (0 in the first). Containers are named from Docker's list, looked up
 * again every 10 s (a process in a container without a name yet shows "a container").
 */
@Injectable()
export class ProcessesTopic implements TopicSource<'processes'> {
  readonly topic = 'processes';
  private readonly logger = new Logger(ProcessesTopic.name);
  private run: Run | null = null;
  private containers = new Map<string, ContainerName>();
  private containersAt = -Infinity;
  private refreshingContainers: Promise<void> | null = null;

  /** While subscribed: a reading at once, then one 2 s after each reading ends. */
  readonly updates$: Observable<ProcessesUpdate> = defer(() => {
    const run = this.begin();
    return defer(() => this.read(run)).pipe(
      repeat({ delay: () => timer(PROCESSES_INTERVAL_MS) }),
      filter((update): update is ProcessesUpdate => update !== null),
      finalize(() => this.end(run)),
    );
  }).pipe(share());

  constructor(
    private readonly reader: SystemReader,
    private readonly docker: DockerService,
    private readonly wrapperConfig: WrapperConfigService,
    subscriptions: RealtimeSubscriptions,
  ) {
    subscriptions.registerSource(this);
  }

  /** Waits for the first reading when collecting has only just started. */
  async snapshot(): Promise<ProcessesUpdate> {
    const run = this.run;
    if (!run) throw new Error('Processes are not being collected');
    return run.latest ?? (await firstValueFrom(run.first$));
  }

  private begin(): Run {
    const run: Run = {
      previousTotal: null,
      previousTicks: new Map(),
      latest: null,
      first$: new ReplaySubject(1),
    };
    this.run = run;
    return run;
  }

  private end(run: Run): void {
    if (this.run === run) this.run = null;
    run.first$.error(new Error('Process collecting stopped'));
  }

  /** One reading, or null for a failed one or one after the end. */
  private async read(run: Run): Promise<ProcessesUpdate | null> {
    try {
      if (Date.now() - this.containersAt >= CONTAINER_NAMES_MS) void this.refreshContainers();
      const [raw, cpu, memory, users, bootTime, partial] = await Promise.all([
        this.reader.processes(),
        this.reader.cpuTimes(),
        this.reader.memory(),
        this.reader.users(),
        this.reader.bootTime(),
        this.reader.procHidden(),
      ]);
      if (run !== this.run) return null;
      const context = {
        users,
        bootTime,
        memoryTotalBytes: memory.totalBytes,
        cpuTotalTicks: run.previousTotal === null ? 0 : cpu.total - run.previousTotal,
        previousTicks: run.previousTicks,
        containers: this.containers,
        rules: endRules(this.wrapperConfig.config.process),
      };
      const update: ProcessesUpdate = {
        processes: raw.map((process) => toProcess(process, context)),
        partial,
      };
      run.previousTotal = cpu.total;
      run.previousTicks = new Map(raw.map((process) => [processKey(process), process.cpuTicks]));
      run.latest = update;
      run.first$.next(update);
      return update;
    } catch (error) {
      this.logger.warn(`Reading the processes failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Docker's containers by full ID; a failure keeps the names known so far. */
  private refreshContainers(): Promise<void> {
    this.refreshingContainers ??= (async () => {
      try {
        const list = await this.docker.listContainers();
        this.containers = new Map(
          list.map((container) => [
            container.id,
            {
              name: container.name,
              catalogId: container.composeProject?.startsWith(COMPOSE_PREFIX)
                ? container.composeProject.slice(COMPOSE_PREFIX.length)
                : null,
            },
          ]),
        );
      } catch {
        // Docker not reachable: processes in containers show without a name.
      } finally {
        this.containersAt = Date.now();
        this.refreshingContainers = null;
      }
    })();
    return this.refreshingContainers;
  }
}
