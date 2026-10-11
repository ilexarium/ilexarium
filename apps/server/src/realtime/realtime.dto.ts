import { logsCloseSchema, logsOpenSchema, topicRequestSchema } from '@homelab/shared';
import { zodDto } from '../common/zod-dto.js';

export class TopicRequestDto extends zodDto(topicRequestSchema) {}
export class LogsOpenDto extends zodDto(logsOpenSchema) {}
export class LogsCloseDto extends zodDto(logsCloseSchema) {}
