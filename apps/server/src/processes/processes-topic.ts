import { Injectable, Logger } from '@nestjs/common';
import { catalogIdOfProject, type ProcessesUpdate, processKey } from '@laris/shared';
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
import { endRules, toProcess } from './process-view.js';
import type { ContainerName } from './processes.model.js';

export const PROCESSES_INTERVAL_MS = 2_000;
/** Containers' names and the accounts are looked up again this often (they rarely change). */
export const NAMES_MS = 10_000;

/** State of one collecting period: while `updates$` is subscribed. */
interface Run {
  /** CPU ticks of the machine and of each process at the previous reading. */
  previousTotal: number | null;
  previousTicks: Map<string, number>;
  latest: ProcessesUpdate | null;
  first$: ReplaySubject<ProcessesUpdate>;
  /** Fixed until the machine restarts: read once per run. */
  bootTime: number | null | undefined;
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
  private users = new Map<number, string>();
  private namesAt = -Infinity;
  private refreshingNames: Promise<void> | null = null;

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
      bootTime: undefined,
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
      // The first reading waits for the names; later ones use what's known meanwhile.
      if (Date.now() - this.namesAt >= NAMES_MS) {
        const refresh = this.refreshNames();
        if (this.namesAt === -Infinity) await refresh;
      }
      run.bootTime ??= await this.reader.bootTime();
      const [raw, cpu, memory, partial] = await Promise.all([
        this.reader.processes(),
        this.reader.cpuTimes(),
        this.reader.memory(),
        this.reader.procHidden(),
      ]);
      if (run !== this.run) return null;
      const context = {
        users: this.users,
        bootTime: run.bootTime,
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

  /**
   * Docker's containers by full ID, and the accounts' names; a failure keeps what's known so far
   * (processes in containers show without a name while Docker can't be reached).
   */
  private refreshNames(): Promise<void> {
    this.refreshingNames ??= (async () => {
      try {
        this.users = await this.reader.users();
        const names = await this.docker.containerNames();
        this.containers = new Map(
          [...names].map(([id, { name, composeProject }]) => [
            id,
            {
              name,
              catalogId: catalogIdOfProject(composeProject),
            },
          ]),
        );
      } catch {
        // Kept as they were.
      } finally {
        this.namesAt = Date.now();
        this.refreshingNames = null;
      }
    })();
    return this.refreshingNames;
  }
}
