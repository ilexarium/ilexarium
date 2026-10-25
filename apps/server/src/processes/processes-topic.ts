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
import { cpuUsagePercent } from '../host/proc-parsers.js';
import type { CpuTimes } from '../host/host.model.js';
import { SystemReader } from '../host/system-reader.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { toProcess } from './process-view.js';
import { NAMES_MS, PROCESSES_INTERVAL_MS } from './processes.constants.js';
import type { ContainerName } from './processes.model.js';

/** State of one collecting period: while `updates$` is subscribed. */
interface Run {
  /** CPU times of the machine and ticks of each process at the previous reading. */
  previousCpu: CpuTimes | null;
  previousTicks: Map<string, number>;
  latest: ProcessesUpdate | null;
  first$: ReplaySubject<ProcessesUpdate>;
  /** Fixed until the machine restarts: read once per run. */
  bootTime: number | null | undefined;
  cores: number | undefined;
}

/**
 * The `processes` topic (docs/plans/process_list.md): every process, read from /proc every 2 s —
 * only while someone has the page open. CPU % is per core between two readings (0 in the
 * first), like htop; the summary's is the whole machine's. Containers are named from Docker's list, looked up
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
    private readonly systemReader: SystemReader,
    private readonly dockerService: DockerService,
    realtimeSubscriptions: RealtimeSubscriptions,
  ) {
    realtimeSubscriptions.registerSource(this);
  }

  /** Waits for the first reading when collecting has only just started. */
  async snapshot(): Promise<ProcessesUpdate> {
    const run = this.run;
    if (!run) throw new Error('Processes are not being collected');
    return run.latest ?? (await firstValueFrom(run.first$));
  }

  private begin(): Run {
    const run: Run = {
      previousCpu: null,
      previousTicks: new Map(),
      latest: null,
      first$: new ReplaySubject(1),
      bootTime: undefined,
      cores: undefined,
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
      run.bootTime ??= await this.systemReader.bootTime();
      run.cores ??= await this.systemReader.cpuCount();
      const load = this.systemReader.loadAverage();
      const [raw, cpu, memory, partial, pressure] = await Promise.all([
        this.systemReader.processes(),
        this.systemReader.cpuTimes(),
        this.systemReader.memory(),
        this.systemReader.procHidden(),
        this.systemReader.pressure(),
      ]);
      if (run !== this.run) return null;
      const context = {
        users: this.users,
        bootTime: run.bootTime,
        memoryTotalBytes: memory.totalBytes,
        cores: run.cores,
        cpuTotalTicks: run.previousCpu === null ? 0 : cpu.total - run.previousCpu.total,
        previousTicks: run.previousTicks,
        containers: this.containers,
      };
      const update: ProcessesUpdate = {
        processes: raw.map((process) => toProcess(process, context)),
        summary: {
          cores: run.cores,
          cpuPercent: run.previousCpu === null ? 0 : cpuUsagePercent(run.previousCpu, cpu),
          load,
          memory: {
            totalBytes: memory.totalBytes,
            availableBytes: memory.availableBytes,
            swapTotalBytes: memory.swapTotalBytes,
            swapUsedBytes: Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes),
          },
          pressure,
        },
        partial,
      };
      run.previousCpu = cpu;
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
        this.users = await this.systemReader.users();
        const names = await this.dockerService.containerNames();
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
