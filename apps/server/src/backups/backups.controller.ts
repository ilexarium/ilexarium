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
} from '@homelab/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { BackupManager } from './backup-manager.js';
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

/** Per IP, for changes (slow, privileged, rare); reads aren't limited. */
const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };
/** Asking for the passphrase: the password is checked, so few tries. */
const PASSPHRASE_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** Backups (docs/plans/backups.md). Every route needs a session. */
@Controller('backups')
@UseFilters(TooManyAttemptsFilter)
export class BackupsController {
  constructor(private readonly backups: BackupManager) {}

  @Get('status')
  status(): Promise<BackupsStatus> {
    return this.backups.status();
  }

  @Get('destinations')
  async destinations(): Promise<BackupDestinationsResponse> {
    return { destinations: await this.backups.destinations() };
  }

  @Get('folders')
  folders(@Query() { path }: BackupFoldersQueryDto): Promise<BackupFoldersResponse> {
    return this.backups.folders(path);
  }

  @Get('plan')
  async plan(): Promise<BackupPlanResponse> {
    return { plan: await this.backups.plan() };
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
    return this.backups.setup(body, { user, ip });
  }

  @Put('plan')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  updatePlan(
    @Body() body: BackupPlanUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupPlan> {
    return this.backups.updatePlan(body, { user, ip });
  }

  @Post('items')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  addItem(
    @Body() { item }: BackupItemDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<BackupItem> {
    return this.backups.addItem(item, { user, ip });
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
    return this.backups.updateItem(id, excludedFields, { user, ip });
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
    return this.backups.removeItem(id, archives === 'delete', { user, ip });
  }

  @Get('items/:id/archives')
  async archives(@Param() { id }: BackupItemIdParamsDto): Promise<BackupArchivesResponse> {
    return { archives: await this.backups.archives(id) };
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
    return this.backups.runNow(body, { user, ip });
  }

  @Get('runs')
  async runs(): Promise<BackupRunsResponse> {
    return { runs: await this.backups.runs() };
  }

  @Get('runs/:id/output')
  runOutput(@Param() { id }: BackupRunIdParamsDto): Promise<BackupRunOutputResponse> {
    return this.backups.runOutput(id);
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
    return this.backups.restore(body, { user, ip });
  }

  @Get('restores')
  async restores(): Promise<BackupRestoresResponse> {
    return { restores: await this.backups.restores() };
  }

  @Get('restores/:id')
  restoreJob(@Param() { id }: BackupRestoreIdParamsDto): Promise<BackupRestore> {
    return this.backups.restoreJob(id);
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
    return this.backups.discardPrevious(id, { user, ip });
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
    return this.backups.passphrase(password, { user, ip });
  }
}
