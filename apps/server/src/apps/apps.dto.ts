import {
  appDeleteRequestSchema,
  appFieldsRequestSchema,
  appFolderQuerySchema,
  appInstallRequestSchema,
  appNameQuerySchema,
  appParamsSchema,
  appSaveRequestSchema,
  appUpdateRequestSchema,
} from '@ilex/shared';
import { zodDto } from '../common/zod-dto.js';

export class AppParamsDto extends zodDto(appParamsSchema) {}
export class AppFolderQueryDto extends zodDto(appFolderQuerySchema) {}
export class AppNameQueryDto extends zodDto(appNameQuerySchema) {}
export class AppFieldsDto extends zodDto(appFieldsRequestSchema) {}
export class AppInstallDto extends zodDto(appInstallRequestSchema) {}
export class AppSaveDto extends zodDto(appSaveRequestSchema) {}
export class AppUpdateDto extends zodDto(appUpdateRequestSchema) {}
export class AppDeleteDto extends zodDto(appDeleteRequestSchema) {}
