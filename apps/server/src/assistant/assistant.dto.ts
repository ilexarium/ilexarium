import {
  aiLibraryParamsSchema,
  aiLibrarySearchSchema,
  aiModelQuerySchema,
  aiPullRequestSchema,
  chatIdParamsSchema,
  chatSendSchema,
} from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class AiPullDto extends zodDto(aiPullRequestSchema) {}
export class AiModelQueryDto extends zodDto(aiModelQuerySchema) {}
export class AiLibrarySearchDto extends zodDto(aiLibrarySearchSchema) {}
export class AiLibraryParamsDto extends zodDto(aiLibraryParamsSchema) {}
export class ChatIdParamsDto extends zodDto(chatIdParamsSchema) {}
export class ChatSendDto extends zodDto(chatSendSchema) {}
