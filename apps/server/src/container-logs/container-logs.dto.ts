import { containerLogsParamsSchema, containerLogsQuerySchema } from '@ilex/shared';
import { zodDto } from '../common/zod-dto.js';

export class ContainerLogsParamsDto extends zodDto(containerLogsParamsSchema) {}
export class ContainerLogsQueryDto extends zodDto(containerLogsQuerySchema) {}
