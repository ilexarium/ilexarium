import { terminalTicketRequestSchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class TerminalTicketDto extends zodDto(terminalTicketRequestSchema) {}
