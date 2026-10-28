import {
  appDeleteRequestSchema,
  appFieldsRequestSchema,
  appFolderQuerySchema,
  appImageTagRequestSchema,
  appInstallRequestSchema,
  appNameQuerySchema,
  appParamsSchema,
  appSaveRequestSchema,
  appTaskQuerySchema,
  appUpdateRequestSchema,
  appVersionsQuerySchema,
} from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class AppParamsDto extends zodDto(appParamsSchema) {}
export class AppFolderQueryDto extends zodDto(appFolderQuerySchema) {}
export class AppTaskQueryDto extends zodDto(appTaskQuerySchema) {}
export class AppNameQueryDto extends zodDto(appNameQuerySchema) {}
export class AppVersionsQueryDto extends zodDto(appVersionsQuerySchema) {}
export class AppFieldsDto extends zodDto(appFieldsRequestSchema) {}
export class AppInstallDto extends zodDto(appInstallRequestSchema) {}
export class AppSaveDto extends zodDto(appSaveRequestSchema) {}
export class AppUpdateDto extends zodDto(appUpdateRequestSchema) {}
export class AppImageTagDto extends zodDto(appImageTagRequestSchema) {}
export class AppDeleteDto extends zodDto(appDeleteRequestSchema) {}
