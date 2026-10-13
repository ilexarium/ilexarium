import { Module } from '@nestjs/common';
import { ExecutorModule } from '../executor/executor.module.js';
import { CatalogService } from './catalog.service.js';

/** The reviewed service recipes (catalog/), checked at startup. */
@Module({
  imports: [ExecutorModule],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
