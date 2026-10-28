import { Global, Module } from '@nestjs/common';
import { ChangesUnderway } from './changes-underway.js';

/** What's being changed on purpose right now (backups, restores, app tasks). */
@Global()
@Module({
  providers: [ChangesUnderway],
  exports: [ChangesUnderway],
})
export class JobsModule {}
