// lib/output.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// What both wrappers print: their markers (@@phase, @@error, @@info, @@result), the programs'
// output prefixed "> ", and the refusal behind every @@error.

import { writeSync } from 'node:fs';

/** A refusal with its code (and the input field it's about), reported as `@@error`. */
export class Refusal extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly field: string | undefined;
  constructor(code: string, message: string, exitCode = 2, field?: string) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.field = field;
  }
}

/** Set once nobody reads the output any more (the app stopped): the work goes on without it. */
let readerGone = false;

/**
 * Writes one line of output. If the reader is gone (EPIPE), the rest is dropped instead of
 * crashing: the wrapper must still finish what it started — a restore starts its service again.
 */
export function emit(line: string): void {
  if (readerGone) return;
  try {
    writeSync(1, `${line}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
    readerGone = true;
  }
}

export const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ');

/**
 * Runs a wrapper's main and ends the process: with its exit code (143 once a signal stopped
 * it), or with its refusal as `@@info` and `@@error` (the code, and the field it's about), or as
 * `internal` for anything unexpected.
 */
export function finish(main: () => Promise<number>, stopped: () => boolean = () => false): void {
  main().then(
    (code) => process.exit(stopped() ? 143 : code),
    (error: unknown) => {
      if (error instanceof Refusal) {
        emit(`@@info ${oneLine(error.message)}`);
        emit(`@@error code=${error.code}${error.field ? ` field=${error.field}` : ''}`);
        process.exit(error.exitCode);
      }
      emit(`@@info unexpected error: ${oneLine(String((error as Error)?.message ?? error))}`);
      emit('@@error code=internal');
      process.exit(6);
    },
  );
}
