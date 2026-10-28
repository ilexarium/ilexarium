import {
  backupFoldersQuerySchema,
  backupItemDeleteQuerySchema,
  backupItemIdParamsSchema,
  backupItemAddRequestSchema,
  backupItemUpdateSchema,
  backupPlanUpdateSchema,
  backupRestoreIdParamsSchema,
  backupRestoreRequestSchema,
  backupRunIdParamsSchema,
  backupRunRequestSchema,
  backupSetupRequestSchema,
} from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class BackupSetupDto extends zodDto(backupSetupRequestSchema) {}
export class BackupPlanUpdateDto extends zodDto(backupPlanUpdateSchema) {}
export class BackupItemDto extends zodDto(backupItemAddRequestSchema) {}
export class BackupItemUpdateDto extends zodDto(backupItemUpdateSchema) {}
export class BackupItemIdParamsDto extends zodDto(backupItemIdParamsSchema) {}
export class BackupItemDeleteQueryDto extends zodDto(backupItemDeleteQuerySchema) {}
export class BackupRunDto extends zodDto(backupRunRequestSchema) {}
export class BackupRunIdParamsDto extends zodDto(backupRunIdParamsSchema) {}
export class BackupRestoreDto extends zodDto(backupRestoreRequestSchema) {}
export class BackupRestoreIdParamsDto extends zodDto(backupRestoreIdParamsSchema) {}
export class BackupFoldersQueryDto extends zodDto(backupFoldersQuerySchema) {}
