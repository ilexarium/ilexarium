import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ExecutorService } from './executor.service.js';
import { WrapperConfigService } from './wrapper-config.js';

/** The single way into privileged territory: typed methods over the root wrappers. */
@Module({
  imports: [AuditModule],
  providers: [ExecutorService, WrapperConfigService],
  exports: [ExecutorService, WrapperConfigService],
})
export class ExecutorModule {}
