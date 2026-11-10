import { terminalTicketRequestSchema } from '@ilex/shared';
import { zodDto } from '../common/zod-dto.js';

export class TerminalTicketDto extends zodDto(terminalTicketRequestSchema) {}
