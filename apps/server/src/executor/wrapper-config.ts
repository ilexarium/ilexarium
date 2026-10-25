import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Env } from '../config/env.schema.js';
import { withDevelopmentDisks } from './development-disks.js';
import type { WrapperBackupConfig, WrapperConfig } from './executor.model.js';

const absolute = z.string().startsWith('/');
const backupConfigSchema = z.object({
  borgBin: absolute,
  systemctlBin: absolute.optional(),
  appUid: z.number().int().optional(),
  appGid: z.number().int().optional(),
  platform: z.object({
    container: z.string().min(1),
    database: z.string().min(1),
    user: z.string().min(1),
    files: z.array(absolute),
  }),
  dev: z
    .object({
      dir: absolute,
      destinationRoots: z.array(absolute),
      mountInfo: absolute,
      lockWaitMs: z.number().int().optional(),
      retryDelayMs: z.number().int().optional(),
    })
    .optional(),
});
const diskConfigSchema = z.object({
  systemctlBin: absolute.optional(),
  dev: z
    .object({ root: absolute, mountRoot: absolute, unitDir: absolute, backupPlan: absolute })
    .optional(),
});
const wrapperConfigSchema = z.object({
  catalogDir: absolute,
  storageRoots: z.array(absolute).min(1),
  serviceRoot: absolute,
  reservedPorts: z.array(z.number().int()),
  protectedPaths: z.array(absolute),
  dockerBin: absolute,
  lockFile: absolute.optional(),
  home: absolute.optional(),
  backup: backupConfigSchema.optional(),
  disk: diskConfigSchema.optional(),
});

const REPO_CATALOG = fileURLToPath(new URL('../../../../catalog', import.meta.url));

/**
 * The deploy wrapper's config, read by the app too: the catalog folder (the same reviewed,
 * root-owned copy the wrapper deploys from), the storage roots and reserved ports — so the app's
 * friendly pre-checks and the wrapper's real ones agree. Production: the installer writes
 * /etc/laris/wrappers.json (root-owned, world-readable). Development: created on first start
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
    // A development config from before backups: add their part.
    if (!this.production && !this.loaded.backup) {
      this.loaded = { ...this.loaded, backup: await this.developmentBackupConfig() };
      await writeFile(this.file, `${JSON.stringify(this.loaded, null, 2)}\n`, { mode: 0o600 });
      this.logger.warn(`Added a development backup config to ${this.file}`);
    }
    // And their disks: a pretend host with pretend disks.
    if (!this.production && !this.loaded.disk && this.loaded.backup?.dev) {
      this.loaded = await withDevelopmentDisks(this.loaded, this.loaded.backup);
      await writeFile(this.file, `${JSON.stringify(this.loaded, null, 2)}\n`, { mode: 0o600 });
      this.logger.warn(`Added a development disk config (pretend disks) to ${this.file}`);
    }
  }

  /**
   * Development backups: the real Borg, the dev database's container, and a pretend USB disk —
   * the folder .dev/mnt/usb, listed as mounted in .dev/backup/mountinfo (the wrapper only
   * accepts mount points; in production it reads /proc/self/mountinfo).
   */
  private async developmentBackupConfig(): Promise<WrapperBackupConfig> {
    const dev = dirname(this.file);
    const backupDir = resolve(dev, 'backup');
    const mnt = resolve(dev, 'mnt');
    const disk = resolve(mnt, 'usb');
    await mkdir(disk, { recursive: true, mode: 0o755 });
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const mountInfo = resolve(backupDir, 'mountinfo');
    await writeFile(
      mountInfo,
      `900 1 0:99 / ${disk.replace(/ /g, '\\040')} rw - ext4 /dev/sdz1 rw\n`,
    );
    return {
      borgBin: ['/usr/bin/borg', '/usr/local/bin/borg'].find(existsSync) ?? '/usr/bin/borg',
      platform: {
        container: 'laris-dev-postgres-1',
        database: 'laris',
        user: 'laris',
        files: [this.file],
      },
      dev: { dir: backupDir, destinationRoots: [mnt], mountInfo },
    };
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
