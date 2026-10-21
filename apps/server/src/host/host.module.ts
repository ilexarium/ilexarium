import { Module } from '@nestjs/common';
import { SystemReader } from './system-reader.js';

@Module({
  providers: [
    // Factory: its optional root argument is for container mode, not for injection.
    { provide: SystemReader, useFactory: () => new SystemReader() },
  ],
  exports: [SystemReader],
})
export class HostModule {}
