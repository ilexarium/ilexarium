import { diskMountRequestSchema, diskUnmountRequestSchema } from '@ilex/shared';
import { zodDto } from '../common/zod-dto.js';

export class DiskMountDto extends zodDto(diskMountRequestSchema) {}
export class DiskUnmountDto extends zodDto(diskUnmountRequestSchema) {}
