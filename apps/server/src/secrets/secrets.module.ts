import { Module } from '@nestjs/common';
import { SecretsService } from './secrets.service.js';

/** Encryption at rest for services' secrets. */
@Module({
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
