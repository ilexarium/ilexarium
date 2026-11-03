import { systemServiceActionParamsSchema, systemServiceParamsSchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class SystemServiceParamsDto extends zodDto(systemServiceParamsSchema) {}
export class SystemServiceActionParamsDto extends zodDto(systemServiceActionParamsSchema) {}
