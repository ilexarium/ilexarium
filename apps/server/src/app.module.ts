import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AuditModule } from './audit/audit.module.js';
import { ZodValidationPipe } from './common/zod-validation.pipe.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [ConfigModule, PrismaModule, AuditModule, HealthModule, UsersModule],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class AppModule {}
