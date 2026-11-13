export type Part = 'lint' | 'format' | 'unit' | 'e2e' | 'install';
export type Stamp = Partial<Record<Part, { commit: string; at: string }>>;
export interface RepoState {
  commit: string;
  clean: boolean;
}

export const STAMP_FILE: string;
export const PARTS: readonly Part[];
export function readStamp(file: string): Stamp;
export function writeStamp(file: string, stamp: Stamp): void;
export function withPassed(stamp: Stamp, part: Part, commit: string, at: string): Stamp;
export function unverified(stamp: Stamp, commit: string): { part: Part; passedAt: string | null }[];
export function notRecordable(before: RepoState, after: RepoState): string | undefined;
