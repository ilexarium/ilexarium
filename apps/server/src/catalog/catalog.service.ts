import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import { loadCatalog } from './catalog-loader.js';
import type { CatalogEntry } from './catalog.model.js';

/** From the same folder the root wrapper deploys from (its config's `catalogDir`). */
@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);
  private entries = new Map<string, CatalogEntry>();

  constructor(private readonly wrapperConfigService: WrapperConfigService) {}

  async onModuleInit(): Promise<void> {
    const dir = this.wrapperConfigService.config.catalogDir;
    const entries = await loadCatalog(dir);
    this.entries = new Map(entries.map((entry) => [entry.meta.id, entry]));
    this.logger.log(`Catalog: ${entries.length} entries from ${dir}`);
  }

  list(): CatalogEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }
}
