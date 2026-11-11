import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LinuxSessions } from './linux-sessions.js';

/** The Linux sign-in: SSH to this machine as a Linux account. */
@Module({
  imports: [AuditModule],
  providers: [LinuxSessions],
  exports: [LinuxSessions],
})
export class LinuxSessionsModule {}
