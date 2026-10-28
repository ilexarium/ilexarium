import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { ProgramConfigService } from './program-config.js';
import { RootPrograms } from './root-programs.js';

/** The root programs (laris-backup, laris-disk), through the signed-in person's sudo. */
@Module({
  imports: [AuditModule, LinuxSessionsModule],
  providers: [RootPrograms, ProgramConfigService],
  exports: [RootPrograms, ProgramConfigService],
})
export class RootProgramsModule {}
