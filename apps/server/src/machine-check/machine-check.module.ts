import { Module } from '@nestjs/common';
import { LinuxSessionsModule } from '../linux-sessions/linux-sessions.module.js';
import { MachineCheckController } from './machine-check.controller.js';
import { MachineCheckService } from './machine-check.service.js';

@Module({
  imports: [LinuxSessionsModule],
  controllers: [MachineCheckController],
  providers: [MachineCheckService],
})
export class MachineCheckModule {}
