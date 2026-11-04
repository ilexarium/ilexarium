import { volumeParamsSchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class VolumeParamsDto extends zodDto(volumeParamsSchema) {}
