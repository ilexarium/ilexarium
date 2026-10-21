import { containerActionParamsSchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class ContainerActionParamsDto extends zodDto(containerActionParamsSchema) {}
