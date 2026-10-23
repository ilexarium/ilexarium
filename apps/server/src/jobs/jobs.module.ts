import { Module } from '@nestjs/common';
import { OperationSlot } from './operation-slot.js';

/** The one slot for privileged operations; `LiveJob` and `jobView()` beside it are plain helpers. */
@Module({
  providers: [OperationSlot],
  exports: [OperationSlot],
})
export class JobsModule {}
