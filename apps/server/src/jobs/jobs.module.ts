import { Module } from '@nestjs/common';
import { OperationSlot } from './operation-slot.js';

/** What deploys and backups share: the one slot for privileged operations. */
@Module({
  providers: [OperationSlot],
  exports: [OperationSlot],
})
export class JobsModule {}
