import { HttpErrorResponse } from '@angular/common/http';
import { inject, Service, signal } from '@angular/core';
import {
  apiErrorResponseSchema,
  CONTAINER_ACTION_ERROR_CODES,
  type ContainerAction,
} from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { Translator } from '../../core/i18n/translator';
import { ContainersApi } from './containers-api';

/** Server codes with their own text (`errors.<code>`). */
const KNOWN_CODES: readonly string[] = Object.values(CONTAINER_ACTION_ERROR_CODES);

/** Keeps a container name in one direction inside a translated sentence (toasts are plain text). */
const isolate = (name: string) => `⁨${name}⁩`;

/**
 * Runs container actions (already confirmed where needed): marks the container as busy while
 * Docker works — shared by every place that shows it, the table and the cards — then says how it
 * went in a toast. Nothing to reset on sign-out: an entry lives only while its request runs.
 */
@Service()
export class ContainerActionRunner {
  private readonly api = inject(ContainersApi);
  private readonly translator = inject(Translator);
  private readonly running = signal<ReadonlyMap<string, ContainerAction>>(new Map());

  /** The action in progress for each container name. */
  readonly pending = this.running.asReadonly();

  async run(name: string, action: ContainerAction): Promise<void> {
    if (this.running().has(name)) return;
    this.running.update((map) => new Map(map).set(name, action));
    const t = this.translator.t.bind(this.translator);
    try {
      await this.api.act(name, action);
      toast.success(t(`containers.done.${action}`, { name: isolate(name) }));
    } catch (error) {
      toast.error(t(`containers.failed.${action}`, { name: isolate(name) }), {
        description: this.errorText(error),
      });
    } finally {
      this.running.update((map) => {
        const next = new Map(map);
        next.delete(name);
        return next;
      });
    }
  }

  private errorText(error: unknown): string {
    const t = this.translator.t.bind(this.translator);
    if (!(error instanceof HttpErrorResponse) || error.status === 0) return t('errors.network');
    if (error.status === 429) return t('errors.tooManyAttempts');
    const code = apiErrorResponseSchema.safeParse(error.error).data?.code;
    return code && KNOWN_CODES.includes(code)
      ? t(`errors.${code}`)
      : t('errors.server', { status: error.status });
  }
}
