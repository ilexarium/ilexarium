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
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type {
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
} from '@laris/shared';
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
  BackupPassphraseDto,
  BackupPlanUpdateDto,
  BackupRestoreDto,
  BackupRestoreIdParamsDto,
  BackupRunDto,
  BackupRunIdParamsDto,
  BackupSetupDto,
} from './backups.dto.js';
import { CHANGE_LIMIT, PASSPHRASE_LIMIT } from './backups.constants.js';

/** Backups (docs/plans/backups.md). Every route needs a session. */
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
  folders(@Query() { path }: BackupFoldersQueryDto): Promise<BackupFoldersResponse> {
    return this.backupChecks.folders(path);
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
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupPassphraseResponse> {
    return this.backupPlanManager.setup(body, { user, ip });
  }

  @Put('plan')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  updatePlan(
    @Body() body: BackupPlanUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupPlan> {
    return this.backupPlanManager.updatePlan(body, { user, ip });
  }

  @Post('items')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  addItem(
    @Body() { item }: BackupItemDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupItem> {
    return this.backupPlanManager.addItem(item, { user, ip });
  }

  @Patch('items/:id')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  updateItem(
    @Param() { id }: BackupItemIdParamsDto,
    @Body() { excludedFields }: BackupItemUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupItem> {
    return this.backupPlanManager.updateItem(id, excludedFields, { user, ip });
  }

  /** Out of the plan; `?archives=delete` (confirmed in the browser) also deletes its backups. */
  @Delete('items/:id')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  removeItem(
    @Param() { id }: BackupItemIdParamsDto,
    @Query() { archives }: BackupItemDeleteQueryDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.backupPlanManager.removeItem(id, archives === 'delete', { user, ip });
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
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupRunStartedResponse> {
    return this.backupRuns.runNow(body, { user, ip });
  }

  @Get('runs')
  async runs(): Promise<BackupRunsResponse> {
    return { runs: await this.backupRuns.runs() };
  }

  @Get('runs/:id/output')
  runOutput(@Param() { id }: BackupRunIdParamsDto): Promise<BackupRunOutputResponse> {
    return this.backupRuns.runOutput(id);
  }

  /** 202: the restore runs on as a job; its progress arrives through the `backups` topic. */
  @Post('restores')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  restore(
    @Body() body: BackupRestoreDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupRestoreStartedResponse> {
    return this.backupRestores.restore(body, { user, ip });
  }

  @Get('restores')
  async restores(): Promise<BackupRestoresResponse> {
    return { restores: await this.backupRestores.restores() };
  }

  @Get('restores/:id')
  restoreJob(@Param() { id }: BackupRestoreIdParamsDto): Promise<BackupRestore> {
    return this.backupRestores.restoreJob(id);
  }

  /** "Delete previous version": the folders a restore in place set aside. */
  @Delete('restores/:id/previous')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  discardPrevious(
    @Param() { id }: BackupRestoreIdParamsDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupRestore> {
    return this.backupRestores.discardPrevious(id, { user, ip });
  }

  /** "Show again": the app password first. */
  @Post('passphrase')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(PASSPHRASE_LIMIT)
  passphrase(
    @Body() { password }: BackupPassphraseDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupPassphraseResponse> {
    return this.backupPlanManager.passphrase(password, { user, ip });
  }
}
