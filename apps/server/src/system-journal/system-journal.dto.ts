import { journalBootsQuerySchema, journalQuerySchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class JournalQueryDto extends zodDto(journalQuerySchema) {}
export class JournalBootsQueryDto extends zodDto(journalBootsQuerySchema) {}
