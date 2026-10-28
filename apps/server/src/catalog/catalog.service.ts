import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_ERROR_CODES, type TemplateDetails, type TemplateSummary } from '@laris/shared';
import type { Env } from '../config/env.schema.js';
import { loadCatalog } from './catalog-loader.js';
import type { CatalogEntry } from './catalog.model.js';

/** The templates (catalog/), checked at startup. */
@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);
  private readonly dir: string;
  private entries = new Map<string, CatalogEntry>();

  constructor(config: ConfigService<Env, true>) {
    this.dir = config.get('CATALOG_DIR', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    const entries = await loadCatalog(this.dir);
    this.entries = new Map(entries.map((entry) => [entry.template.id, entry]));
    this.logger.log(`Catalog: ${entries.length} templates from ${this.dir}`);
  }

  list(): TemplateSummary[] {
    return [...this.entries.values()].map(({ template }) => ({
      id: template.id,
      version: template.version,
      name: template.name,
      category: template.category,
      website: template.website,
    }));
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  require(id: string): CatalogEntry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new NotFoundException({
        message: 'No such template',
        code: APP_ERROR_CODES.templateNotFound,
      });
    }
    return entry;
  }

  details(id: string): TemplateDetails {
    const { template, compose } = this.require(id);
    return { template, compose };
  }

  /** The port inside the container its web page listens on, for the "Open" link. */
  webPort(id: string): number | null {
    return this.entries.get(id)?.template.web?.port ?? null;
  }
}
