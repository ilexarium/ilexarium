import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { SystemServicesController } from './system-services.controller.js';
import { SystemServicesService } from './system-services.service.js';

/** The host's systemd services (docs/plans/system_services.md). */
@Module({
  imports: [AuditModule, LinuxSessionsModule],
  controllers: [SystemServicesController],
  providers: [SystemServicesService],
})
export class SystemServicesModule {}
