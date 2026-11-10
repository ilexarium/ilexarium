import { BadRequestException, Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import { CurrentSession, CurrentUser, type SessionRecord } from '@nestjs/authentication';
import type { Response } from 'express';
import { logTimestampSchema, type PublicUser } from '@ilex/shared';
import { ContainerLogsParamsDto, ContainerLogsQueryDto } from './container-logs.dto.js';
import { ContainerLogStreams } from './container-log-streams.js';

@Controller('containers')
export class ContainerLogsController {
  constructor(private readonly containerLogStreams: ContainerLogStreams) {}

  /** A reconnect continues after its `Last-Event-ID` (the last line's time), in place of `since`. */
  @Get(':name/logs')
  async logs(
    @Param() { name }: ContainerLogsParamsDto,
    @Query() { tail, since }: ContainerLogsQueryDto,
    @Headers('last-event-id') lastEventId: string | undefined,
    @CurrentSession() session: SessionRecord,
    @CurrentUser() user: PublicUser,
    @Res() res: Response,
  ): Promise<void> {
    if (lastEventId !== undefined && !logTimestampSchema.safeParse(lastEventId).success) {
      throw new BadRequestException('Invalid Last-Event-ID');
    }
    const from = lastEventId ?? since;
    await this.containerLogStreams.serve(
      res,
      { name, tail, ...(from !== undefined && { since: from }) },
      { sessionId: session.id, userId: user.id },
    );
  }
}
