import { ConflictException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AI_ERROR_CODES, type AiPull, type PublicUser } from '@homelab/shared';
import { type Observable, Subject } from 'rxjs';
import { AuditService } from '../audit/audit.service.js';
import { SystemReader } from '../host/system-reader.js';
import { FREE_SPACE_MARGIN_BYTES } from './assistant.constants.js';
import { OllamaError } from './ollama-client.js';
import { OllamaService } from './ollama-service.js';

/** Who asked: for the audit log. */
export interface Requester {
  user: PublicUser;
  ip: string;
}

/**
 * Model downloads (docs/plans/ai_assistant.md): one at a time, by Ollama itself, their progress
 * for the `assistant` topic. A download stops when the models' disk would get too full. Audited
 * (`requested` first: no record, no download).
 */
@Injectable()
export class ModelPulls implements OnModuleDestroy {
  private readonly logger = new Logger(ModelPulls.name);
  private readonly changes = new Subject<void>();
  /** Something about the download changed. */
  readonly changes$: Observable<void> = this.changes.asObservable();
  private current: AiPull | null = null;
  private running: AbortController | null = null;

  constructor(
    private readonly ollama: OllamaService,
    private readonly host: SystemReader,
    private readonly audit: AuditService,
  ) {}

  /** The current or last download (null: none since the server started). */
  view(): AiPull | null {
    return this.current ? { ...this.current } : null;
  }

  /** Starts a download; its progress comes through the topic. */
  async start(model: string, by: Requester): Promise<AiPull> {
    if (this.running) {
      throw new ConflictException({
        message: 'A model is downloading',
        code: AI_ERROR_CODES.pullRunning,
      });
    }
    // Claimed before the first await: two requests can't both start.
    const controller = new AbortController();
    this.running = controller;
    try {
      const { client, location } = await this.ollama.client();
      const space = location.modelsDir ? await this.host.space(location.modelsDir) : null;
      if (space && space.freeBytes < FREE_SPACE_MARGIN_BYTES) {
        throw new ConflictException({
          message: 'The models disk is full',
          code: AI_ERROR_CODES.notEnoughSpace,
        });
      }
      await this.audit.record(this.entry('requested', model, by));
      this.current = {
        model,
        status: 'running',
        completedBytes: 0,
        totalBytes: 0,
        errorCode: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      this.changes.next();
      void this.run(
        model,
        client.pull(model, controller.signal),
        location.modelsDir,
        by,
        controller,
      );
      return this.view()!;
    } catch (error) {
      this.running = null;
      throw error;
    }
  }

  onModuleDestroy(): void {
    this.running?.abort();
    this.changes.complete();
  }

  private async run(
    model: string,
    lines: AsyncGenerator<{ digest?: string; total?: number; completed?: number }>,
    modelsDir: string | null,
    by: Requester,
    controller: AbortController,
  ): Promise<void> {
    const totals = new Map<string, number>();
    const done = new Map<string, number>();
    let errorCode: string | null = null;
    try {
      for await (const line of lines) {
        if (!line.digest || !line.total) continue;
        const known = totals.has(line.digest);
        totals.set(line.digest, line.total);
        done.set(line.digest, line.completed ?? 0);
        const totalBytes = sum(totals);
        const completedBytes = sum(done);
        if (!known && modelsDir && (await this.tooBig(modelsDir, totalBytes - completedBytes))) {
          errorCode = AI_ERROR_CODES.notEnoughSpace;
          controller.abort();
          break;
        }
        this.update({ totalBytes, completedBytes });
      }
    } catch (error) {
      errorCode ??=
        error instanceof OllamaError && /not exist|not found|manifest/i.test(error.message)
          ? AI_ERROR_CODES.modelNotFound
          : AI_ERROR_CODES.pullFailed;
      if (!controller.signal.aborted)
        this.logger.warn(`Download of ${model} failed: ${String(error)}`);
    }
    this.running = null;
    const succeeded = errorCode === null && !controller.signal.aborted;
    this.update({
      status: succeeded ? 'succeeded' : 'failed',
      errorCode: succeeded ? null : (errorCode ?? AI_ERROR_CODES.pullFailed),
      completedBytes: succeeded ? sum(totals) : sum(done),
      finishedAt: new Date().toISOString(),
    });
    await this.audit.tryRecord({
      ...this.entry(succeeded ? 'success' : 'failure', model, by),
      ...(succeeded ? {} : { details: { model, errorCode: this.current?.errorCode ?? '' } }),
    });
  }

  /** Whether the rest of a download would leave the models' disk too full. */
  private async tooBig(modelsDir: string, remaining: number): Promise<boolean> {
    const space = await this.host.space(modelsDir);
    return space !== null && space.freeBytes - remaining < FREE_SPACE_MARGIN_BYTES;
  }

  private update(change: Partial<AiPull>): void {
    if (!this.current) return;
    this.current = { ...this.current, ...change };
    this.changes.next();
  }

  private entry(outcome: 'requested' | 'success' | 'failure', model: string, by: Requester) {
    return {
      action: 'assistant.model_pull' as const,
      outcome,
      userId: by.user.id,
      username: by.user.username,
      ip: by.ip,
      details: { model },
    };
  }
}

function sum(values: Map<string, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}
