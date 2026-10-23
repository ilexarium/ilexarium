import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { FileList, FileSummary, LinuxSession, PublicUser } from '@laris/shared';
import contentDisposition from 'content-disposition';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { SIGN_IN_LIMIT } from '../linux-sessions/linux-sessions.constants.js';
import {
  FilePathQueryDto,
  FileRenameDto,
  FileUploadQueryDto,
  LinuxSignInDto,
  NewFolderDto,
} from './files.dto.js';
import { FilesService } from './files.service.js';

/**
 * Linux sign-in and the file explorer (docs/plans/files_and_terminal.md). Every route needs an
 * app session; the file routes also a Linux session (403 `linux_session_required` otherwise —
 * never 401, which means the app session is gone).
 */
@Controller('files')
@UseFilters(TooManyAttemptsFilter)
export class FilesController {
  constructor(
    private readonly linuxSessions: LinuxSessions,
    private readonly filesService: FilesService,
  ) {}

  @Get('session')
  session(@CurrentSession() session: { id: string }): { session: LinuxSession | null } {
    return { session: this.linuxSessions.current(session.id) };
  }

  /** Sign in as a Linux user (the password goes to sshd, nowhere else). */
  @Post('session')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(SIGN_IN_LIMIT)
  signIn(
    @Body() body: LinuxSignInDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<LinuxSession> {
    return this.linuxSessions.signIn(session.id, body, { user, ip });
  }

  @Delete('session')
  @HttpCode(204)
  signOut(
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.linuxSessions.signOut(session.id, { user, ip });
  }

  @Get('list')
  list(
    @Query() { path }: FilePathQueryDto,
    @CurrentSession() session: { id: string },
  ): Promise<FileList> {
    return this.filesService.list(session.id, path);
  }

  @Get('summary')
  summary(
    @Query() { path }: FilePathQueryDto,
    @CurrentSession() session: { id: string },
  ): Promise<FileSummary> {
    return this.filesService.summary(session.id, path);
  }

  /** Always an attachment, never shown in the browser: a file from a disk never runs as the app. */
  @Get('download')
  async download(
    @Query() { path }: FilePathQueryDto,
    @CurrentSession() session: { id: string },
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.filesService.download(session.id, path);
    res.status(200).set({
      'Content-Type': 'application/octet-stream',
      // RFC 6266 for any name: a Latin-1 fallback, and the real name encoded when it needs it.
      'Content-Disposition': contentDisposition(file.name),
      'Content-Length': String(file.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store',
    });
    await pipeline(file.stream, res).catch(() => res.destroy());
  }

  /** The file is the request's body (streamed through, never held in memory). */
  @Put('upload')
  @HttpCode(204)
  upload(
    @Query() query: FileUploadQueryDto,
    @Req() req: Request,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    const length = req.headers['content-length'];
    const size = length !== undefined && /^\d+$/.test(length) ? Number(length) : null;
    return this.filesService.upload(
      session.id,
      { folder: query.folder, name: query.name, replace: query.replace === 'true' },
      req,
      size,
      { user, ip },
    );
  }

  @Post('folder')
  @HttpCode(204)
  newFolder(@Body() body: NewFolderDto, @CurrentSession() session: { id: string }): Promise<void> {
    return this.filesService.newFolder(session.id, body.parent, body.name);
  }

  @Post('rename')
  @HttpCode(204)
  rename(
    @Body() body: FileRenameDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.filesService.rename(session.id, body.from, body.to, { user, ip });
  }

  @Delete()
  @HttpCode(204)
  delete(
    @Query() { path }: FilePathQueryDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.filesService.delete(session.id, path, { user, ip });
  }
}
