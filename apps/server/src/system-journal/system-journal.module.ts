import { Module } from '@nestjs/common';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { SystemJournalController } from './system-journal.controller.js';
import { SystemJournalService } from './system-journal.service.js';

/** The machine's journal (docs/plans/system_logs.md). */
@Module({
  imports: [LinuxSessionsModule],
  controllers: [SystemJournalController],
  providers: [SystemJournalService],
})
export class SystemJournalModule {}
