import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type {
  AppStarted,
  BackupArchivesResponse,
  BackupDestinationsResponse,
  BackupFoldersResponse,
  BackupItem,
  BackupPassphraseResponse,
  BackupPlan,
  BackupPlanResponse,
  BackupRestore,
  BackupRestoresResponse,
  BackupRestoreStartedResponse,
  BackupRunOutputResponse,
  BackupRunsResponse,
  BackupRunStartedResponse,
  BackupsStatus,
  PublicUser,
} from '@ilex/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { BackupChecks } from './backup-checks.js';
import { BackupPlanManager } from './backup-plan-manager.js';
import { BackupRestores } from './backup-restores.js';
import { BackupRuns } from './backup-runs.js';
import { BackupStatusReader } from './backup-status-reader.js';
import {
  BackupFoldersQueryDto,
  BackupItemDeleteQueryDto,
  BackupItemDto,
  BackupItemIdParamsDto,
  BackupItemUpdateDto,
  BackupPlanUpdateDto,
  BackupRestoreApplyDto,
  BackupRestoreDto,
  BackupRestoreIdParamsDto,
  BackupRunDto,
  BackupRunIdParamsDto,
  BackupSetupDto,
} from './backups.dto.js';
import { CHANGE_LIMIT, PASSPHRASE_LIMIT } from './backups.constants.js';

/** Backups. Every route needs a session. */
@Controller('backups')
@UseFilters(TooManyAttemptsFilter)
export class BackupsController {
  constructor(
    private readonly backupPlanManager: BackupPlanManager,
    private readonly backupChecks: BackupChecks,
    private readonly backupRuns: BackupRuns,
    private readonly backupRestores: BackupRestores,
    private readonly backupStatusReader: BackupStatusReader,
  ) {}

  @Get('status')
  status(): Promise<BackupsStatus> {
    return this.backupStatusReader.status();
  }

  @Get('destinations')
  async destinations(): Promise<BackupDestinationsResponse> {
    return { destinations: await this.backupChecks.destinations() };
  }

  @Get('folders')
  folders(
    @Query() { path }: BackupFoldersQueryDto,
    @CurrentSession() session: { id: string },
  ): Promise<BackupFoldersResponse> {
    return this.backupChecks.folders(session.id, path);
  }

  @Get('plan')
  async plan(): Promise<BackupPlanResponse> {
    return { plan: await this.backupPlanManager.plan() };
  }

  /** Setting up: the repository and its passphrase, shown once in the response. */
  @Post('plan')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  setup(
    @Body() body: BackupSetupDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupPassphraseResponse> {
    return this.backupPlanManager.setup(body, { user, ip, appSessionId: session.id });
  }

  @Put('plan')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  updatePlan(
    @Body() body: BackupPlanUpdateDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupPlan> {
    return this.backupPlanManager.updatePlan(body, { user, ip, appSessionId: session.id });
  }

  @Post('items')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  addItem(
    @Body() { item }: BackupItemDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupItem> {
    return this.backupPlanManager.addItem(item, { user, ip, appSessionId: session.id });
  }

  @Patch('items/:id')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  updateItem(
    @Param() { id }: BackupItemIdParamsDto,
    @Body() change: BackupItemUpdateDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupItem> {
    return this.backupPlanManager.updateItem(id, change, { user, ip, appSessionId: session.id });
  }

  /** Out of the plan; `?archives=delete` (confirmed in the browser) also deletes its backups. */
  @Delete('items/:id')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  removeItem(
    @Param() { id }: BackupItemIdParamsDto,
    @Query() { archives }: BackupItemDeleteQueryDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.backupPlanManager.removeItem(id, archives === 'delete', {
      user,
      ip,
      appSessionId: session.id,
    });
  }

  /** Each item's archives read again from the disk, through the person's sudo ("Restore…"). */
  @Post('archives/refresh')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  refreshArchives(
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.backupPlanManager.refreshArchives({ user, ip, appSessionId: session.id });
  }

  @Get('items/:id/archives')
  async archives(@Param() { id }: BackupItemIdParamsDto): Promise<BackupArchivesResponse> {
    return { archives: await this.backupPlanManager.archives(id) };
  }

  /** 202: "Back up now" runs on; its progress arrives through the `backups` topic. */
  @Post('runs')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  run(
    @Body() body: BackupRunDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupRunStartedResponse> {
    return this.backupRuns.runNow(body, { user, ip, appSessionId: session.id });
  }

  @Get('runs')
  async runs(): Promise<BackupRunsResponse> {
    return { runs: await this.backupRuns.runs() };
  }

  @Get('runs/:id/output')
  runOutput(@Param() { id }: BackupRunIdParamsDto): Promise<BackupRunOutputResponse> {
    return this.backupRuns.runOutput(id);
  }

  /** 202: the restore runs on as its own unit; its progress arrives through the `backups` topic. */
  @Post('restores')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  restore(
    @Body() body: BackupRestoreDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupRestoreStartedResponse> {
    return this.backupRestores.restore(body, { user, ip, appSessionId: session.id });
  }

  @Get('restores')
  async restores(): Promise<BackupRestoresResponse> {
    return { restores: await this.backupRestores.restores() };
  }

  @Get('restores/:id')
  restoreJob(@Param() { id }: BackupRestoreIdParamsDto): Promise<BackupRestore> {
    return this.backupRestores.restoreJob(id);
  }

  /** "Delete previous version": the folders a restore set aside. */
  @Delete('restores/:id/previous')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  discardPrevious(
    @Param() { id }: BackupRestoreIdParamsDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupRestore> {
    return this.backupRestores.discardPrevious(id, { user, ip, appSessionId: session.id });
  }

  /** "Apply the restored settings": the restored app's `up` task, as the person. */
  @Post('restores/:id/apply')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  applyRestored(
    @Param() { id }: BackupRestoreIdParamsDto,
    @Body() { folder }: BackupRestoreApplyDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<AppStarted> {
    return this.backupRestores.apply(id, folder, { user, ip, appSessionId: session.id });
  }

  /** "Show again": through the person's sudo. */
  @Post('passphrase')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSPHRASE_LIMIT)
  passphrase(
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupPassphraseResponse> {
    return this.backupPlanManager.passphrase({ user, ip, appSessionId: session.id });
  }
}
