import { Controller, Get, Header, Query } from '@nestjs/common';
import { CurrentSession } from '@nestjs/authentication';
import type { JournalBootsResponse, JournalResponse } from '@ilex/shared';
import { JournalBootsQueryDto, JournalQueryDto } from './system-journal.dto.js';
import { SystemJournalService } from './system-journal.service.js';

/**
 * The machine's journal, read as the signed-in Linux account (403 `linux_session_required`
 * without one), or as administrator through its unlocked sudo (403 `sudo_required`).
 */
@Controller('system/journal')
export class SystemJournalController {
  constructor(private readonly systemJournalService: SystemJournalService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  read(
    @Query() query: JournalQueryDto,
    @CurrentSession() session: { id: string },
  ): Promise<JournalResponse> {
    return this.systemJournalService.read(session.id, query);
  }

  @Get('boots')
  @Header('Cache-Control', 'no-store')
  boots(
    @Query() query: JournalBootsQueryDto,
    @CurrentSession() session: { id: string },
  ): Promise<JournalBootsResponse> {
    return this.systemJournalService.boots(session.id, query.administrator ?? false);
  }
}
