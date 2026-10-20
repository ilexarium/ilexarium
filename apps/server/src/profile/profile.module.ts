import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { UsersModule } from '../users/users.module.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';

/** The signed-in person's profile and picture (`/api/profile`), see docs/plans/profile.md. */
@Module({
  imports: [UsersModule, AuditModule],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
