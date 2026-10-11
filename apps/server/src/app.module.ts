import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ZodValidationPipe } from './common/zod-validation.pipe.js';
import { ConfigModule } from './config/config.module.js';
import { ContainersModule } from './containers/containers.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { SystemMetricsModule } from './system-metrics/system-metrics.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    HealthModule,
    UsersModule,
    RealtimeModule,
    SystemMetricsModule,
    ContainersModule,
  ],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class AppModule {}
