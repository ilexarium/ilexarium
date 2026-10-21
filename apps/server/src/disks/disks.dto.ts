import { diskMountRequestSchema, diskNameParamsSchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class DiskMountDto extends zodDto(diskMountRequestSchema) {}
export class DiskNameParamsDto extends zodDto(diskNameParamsSchema) {}
