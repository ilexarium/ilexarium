import { startUpdateSchema, updateSettingsSchema } from '@ilex/shared';
import { zodDto } from '../common/zod-dto.js';

export class StartUpdateDto extends zodDto(startUpdateSchema) {}
export class UpdateSettingsDto extends zodDto(updateSettingsSchema) {}
