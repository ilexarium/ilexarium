import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type {
  AppDetails,
  AppFields,
  AppNameCheck,
  AppRemoval,
  AppStarted,
  AppTask,
  AppsList,
  PublicUser,
} from '@ilex/shared';
import { AppManager } from './app-manager.js';
import {
  AppDeleteDto,
  AppFieldsDto,
  AppFolderQueryDto,
  AppInstallDto,
  AppNameQueryDto,
  AppParamsDto,
  AppSaveDto,
  AppUpdateDto,
} from './apps.dto.js';
import { CHANGE_LIMIT } from './apps.constants.js';

type Session = { id: string };

/** Everything but the list is done as the signed-in Linux account. */
@Controller('apps')
export class AppsController {
  constructor(private readonly appManager: AppManager) {}

  @Get()
  async list(@CurrentSession() session: Session): Promise<AppsList> {
    return { apps: await this.appManager.list(session.id) };
  }

  @Get('name')
  name(
    @CurrentSession() session: Session,
    @Query() { name }: AppNameQueryDto,
  ): Promise<AppNameCheck> {
    return this.appManager.checkName(session.id, name);
  }

  @Post('fields')
  @HttpCode(200)
  fields(@CurrentSession() session: Session, @Body() { template }: AppFieldsDto): AppFields {
    return this.appManager.fields(session.id, template);
  }

  /** 202: the task runs on as a unit; its output from `GET :name/task`. */
  @Post()
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  install(
    @CurrentSession() session: Session,
    @Body() body: AppInstallDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<AppStarted> {
    return this.appManager.install(session.id, body, { user, ip });
  }

  @Get(':name')
  details(
    @CurrentSession() session: Session,
    @Param() { name }: AppParamsDto,
    @Query() { folder }: AppFolderQueryDto,
  ): Promise<AppDetails> {
    return this.appManager.details(session.id, name, folder);
  }

  @Get(':name/task')
  async task(
    @CurrentSession() session: Session,
    @Param() { name }: AppParamsDto,
    @Query() { folder }: AppFolderQueryDto,
  ): Promise<{ task: AppTask | null }> {
    return { task: await this.appManager.task(session.id, name, folder) };
  }

  @Put(':name/files')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  save(
    @CurrentSession() session: Session,
    @Param() { name }: AppParamsDto,
    @Body() body: AppSaveDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<AppStarted> {
    return this.appManager.save(session.id, name, body, { user, ip });
  }

  @Post(':name/update')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  update(
    @CurrentSession() session: Session,
    @Param() { name }: AppParamsDto,
    @Body() { folder }: AppUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<AppStarted> {
    return this.appManager.update(session.id, name, folder, { user, ip });
  }

  @Get(':name/removal')
  removal(
    @CurrentSession() session: Session,
    @Param() { name }: AppParamsDto,
    @Query() { folder }: AppFolderQueryDto,
  ): Promise<AppRemoval> {
    return this.appManager.removal(session.id, name, folder ?? '');
  }

  @Post(':name/remove')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  remove(
    @CurrentSession() session: Session,
    @Param() { name }: AppParamsDto,
    @Body() { folder }: AppUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<AppStarted> {
    return this.appManager.remove(session.id, name, folder, { user, ip });
  }

  @Post(':name/delete')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  delete(
    @CurrentSession() session: Session,
    @Param() { name }: AppParamsDto,
    @Body() body: AppDeleteDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.appManager.delete(session.id, name, body, { user, ip });
  }
}
