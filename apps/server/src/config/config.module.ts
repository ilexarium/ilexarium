import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema.js';

/** Loads `.env` (if present) and validates the environment once, at startup. */
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv })],
})
export class ConfigModule {}
