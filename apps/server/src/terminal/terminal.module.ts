import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { TerminalController } from './terminal.controller.js';
import { TerminalGateway } from './terminal.gateway.js';
import { TerminalTickets } from './terminal-tickets.js';
import { Terminals } from './terminals.js';

/** The web terminal, over the Linux sign-in. */
@Module({
  imports: [AuditModule, AuthModule, LinuxSessionsModule],
  controllers: [TerminalController],
  providers: [TerminalGateway, TerminalTickets, Terminals],
})
export class TerminalModule {}
