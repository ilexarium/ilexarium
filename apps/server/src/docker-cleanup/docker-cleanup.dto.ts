import { volumeParamsSchema } from '@ilex/shared';
import { zodDto } from '../common/zod-dto.js';

export class VolumeParamsDto extends zodDto(volumeParamsSchema) {}
