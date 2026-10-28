import { processSignalRequestSchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class ProcessSignalDto extends zodDto(processSignalRequestSchema) {}
