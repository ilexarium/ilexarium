import { Module } from '@nestjs/common';
import { SystemReader } from './system-reader.js';

/**
 * Reading the host's state — `/proc`, `/sys`, `/etc`, folders, `statfs()`, Node's `os` — in one
 * place, with one configurable root (container mode, if ever: the host's root mounted in).
 * Read-only, no commands, no privileges; changing the host goes through the executor.
 */
@Module({
  providers: [
    // Factory: its optional root argument is for container mode, not for injection.
    { provide: SystemReader, useFactory: () => new SystemReader() },
  ],
  exports: [SystemReader],
})
export class HostModule {}
