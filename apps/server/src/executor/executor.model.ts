import type { FieldValues, JobPhase, PublicUser, ServiceErrorCode } from '@homelab/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** The deploy wrapper's config file (the same file the wrapper reads, as root, in production). */
export interface WrapperConfig {
  catalogDir: string;
  storageRoots: string[];
  serviceRoot: string;
  reservedPorts: number[];
  protectedPaths: string[];
  dockerBin: string;
  lockFile?: string;
  home?: string;
}

/** Who asked, for the audit log. */
export interface ExecutorActor {
  user: PublicUser;
  ip?: string;
}

export interface ComposeRequest {
  catalogId: string;
  serviceId: string;
  /** `up` only: every value the wrapper gets — secrets decrypted. Goes on stdin, nowhere else. */
  values?: FieldValues;
  /** Replaced by •••• in every output line. */
  secrets: readonly string[];
  /** The entry's field keys: an `@@error field=` must be one of them. */
  fields: readonly string[];
  actor: ExecutorActor;
  /** Extra audit details — never secrets (the audit log refuses secret-like keys anyway). */
  audit: Record<string, Prisma.InputJsonValue>;
  onPhase: (phase: JobPhase) => void;
  onOutput: (line: string) => void;
}

export type ComposeOutcome =
  { ok: true } | { ok: false; code: ServiceErrorCode; field: string | null };
