import { topicRequestSchema } from '@homelab/shared';
import { zodDto } from '../common/zod-dto.js';

export class TopicRequestDto extends zodDto(topicRequestSchema) {}
