import { Module } from '@nestjs/common';
import { OperationSlot } from './operation-slot.js';

/** One privileged operation at a time (`OperationSlot`), and a running job's progress (`LiveJob`). */
@Module({
  providers: [OperationSlot],
  exports: [OperationSlot],
})
export class JobsModule {}
