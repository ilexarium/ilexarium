import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Env } from '../config/env.schema.js';
import type { WrapperConfig } from './executor.model.js';

const absolute = z.string().startsWith('/');
const wrapperConfigSchema = z.object({
  catalogDir: absolute,
  storageRoots: z.array(absolute).min(1),
  serviceRoot: absolute,
  reservedPorts: z.array(z.number().int()),
  protectedPaths: z.array(absolute),
  dockerBin: absolute,
  lockFile: absolute.optional(),
  home: absolute.optional(),
});

const REPO_CATALOG = fileURLToPath(new URL('../../../../catalog', import.meta.url));

/**
 * The deploy wrapper's config, read by the app too: the catalog folder (the same reviewed,
 * root-owned copy the wrapper deploys from), the storage roots and reserved ports — so the app's
 * friendly pre-checks and the wrapper's real ones agree. Production: the installer writes
 * /etc/homelab/wrappers.json (root-owned, world-readable). Development: created on first start
 * under .dev/, with .dev/srv as the storage root.
 */
@Injectable()
export class WrapperConfigService implements OnModuleInit {
  private readonly logger = new Logger(WrapperConfigService.name);
  readonly file: string;
  private readonly production: boolean;
  private readonly port: number;
  private loaded: WrapperConfig | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.file = resolve(config.get('WRAPPER_CONFIG_FILE', { infer: true }));
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
    this.port = config.get('PORT', { infer: true });
  }

  get config(): WrapperConfig {
    if (!this.loaded) throw new Error('The wrapper config is not loaded');
    return this.loaded;
  }

  async onModuleInit(): Promise<void> {
    if (!existsSync(this.file)) {
      if (this.production) throw new Error(`${this.file} is missing (the installer writes it)`);
      await this.createDevelopmentConfig();
    }
    const parsed = wrapperConfigSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
    if (!parsed.success) throw new Error(`Invalid ${this.file}: ${z.prettifyError(parsed.error)}`);
    this.loaded = parsed.data;
  }

  private async createDevelopmentConfig(): Promise<void> {
    const dev = dirname(this.file);
    const storage = resolve(dev, 'srv');
    await mkdir(storage, { recursive: true, mode: 0o755 });
    const config: WrapperConfig = {
      catalogDir: REPO_CATALOG,
      storageRoots: [storage],
      serviceRoot: storage,
      reservedPorts: [...new Set([22, 53, 2375, 4200, 5432, 41641, this.port])],
      protectedPaths: [],
      dockerBin: ['/usr/bin/docker', '/usr/local/bin/docker'].find(existsSync) ?? '/usr/bin/docker',
      lockFile: resolve(dev, 'compose.lock'),
      home: homedir(),
    };
    await writeFile(this.file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    this.logger.warn(
      `Created a development wrapper config in ${this.file} (storage root ${storage})`,
    );
  }
}
