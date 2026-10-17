import { processSignalRequestSchema } from '@homelab/shared';
import { zodDto } from '../common/zod-dto.js';

export class ProcessSignalDto extends zodDto(processSignalRequestSchema) {}
