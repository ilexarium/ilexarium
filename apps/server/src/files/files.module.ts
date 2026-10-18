import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { HostModule } from '../host/host.module.js';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

/** The file explorer (docs/plans/files_and_terminal.md), over the Linux sign-in. */
@Module({
  imports: [AuditModule, HostModule, LinuxSessionsModule],
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
