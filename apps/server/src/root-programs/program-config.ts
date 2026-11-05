import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Env } from '../config/env.schema.js';
import { withDevelopmentDisks } from './development-disks.js';
import { LARIS_VERSION } from '../common/laris-version.js';
import type {
  ProgramBackupConfig,
  ProgramConfig,
  ProgramUpdateConfig,
} from './root-programs.model.js';

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
const updateConfigSchema = z.object({
  appGid: z.number().int().optional(),
  dev: z.object({ root: absolute, bin: absolute, healthUrl: z.string() }).optional(),
});
const programConfigSchema = z.object({
  protectedPaths: z.array(absolute),
  dockerBin: absolute,
  lockFile: absolute.optional(),
  home: absolute.optional(),
  backup: backupConfigSchema.optional(),
  disk: diskConfigSchema.optional(),
  update: updateConfigSchema.optional(),
});

/**
 * The root programs' config (laris-backup, laris-disk), read by the app too: the platform's
 * folders, the backup and disk parts. Production: the installer writes
 * /etc/laris/wrappers.json (root-owned, world-readable). Development: created on first start
 * under .dev/.
 */
@Injectable()
export class ProgramConfigService implements OnModuleInit {
  private readonly logger = new Logger(ProgramConfigService.name);
  readonly file: string;
  private readonly production: boolean;
  private readonly port: number;
  private loaded: ProgramConfig | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.file = resolve(config.get('WRAPPER_CONFIG_FILE', { infer: true }));
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
    this.port = config.get('PORT', { infer: true });
  }

  get config(): ProgramConfig {
    if (!this.loaded) throw new Error('The root programs’ config is not loaded');
    return this.loaded;
  }

  async onModuleInit(): Promise<void> {
    if (!existsSync(this.file)) {
      if (this.production) throw new Error(`${this.file} is missing (the installer writes it)`);
      await this.createDevelopmentConfig();
    }
    const parsed = programConfigSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
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
    if (!this.production && !this.loaded.update) {
      this.loaded = { ...this.loaded, update: await this.developmentUpdateConfig() };
      await writeFile(this.file, `${JSON.stringify(this.loaded, null, 2)}\n`, { mode: 0o600 });
      this.logger.warn(`Added a development update config (a pretend machine) to ${this.file}`);
    }
  }

  /**
   * Development updates: laris-update against a pretend machine under .dev/update — its
   * etc/laris holds the installed version, and release.env and release.pub once a developer puts
   * a test release folder there. Its programs folder is empty on purpose: an update gets as far
   * as unpacking, then fails without touching this machine.
   */
  private async developmentUpdateConfig(): Promise<ProgramUpdateConfig> {
    const root = resolve(dirname(this.file), 'update');
    const bin = resolve(root, 'bin');
    await mkdir(resolve(root, 'etc/laris'), { recursive: true, mode: 0o700 });
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await writeFile(resolve(root, 'etc/laris/version'), `${LARIS_VERSION}\n`);
    return { dev: { root, bin, healthUrl: `http://127.0.0.1:${this.port}/api/health` } };
  }

  /**
   * Development backups: the real Borg, the dev database's container, and a pretend USB disk —
   * the folder .dev/mnt/usb, listed as mounted in .dev/backup/mountinfo (the wrapper only
   * accepts mount points; in production it reads /proc/self/mountinfo).
   */
  private async developmentBackupConfig(): Promise<ProgramBackupConfig> {
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
    const config: ProgramConfig = {
      protectedPaths: [],
      dockerBin: ['/usr/bin/docker', '/usr/local/bin/docker'].find(existsSync) ?? '/usr/bin/docker',
      lockFile: resolve(dev, 'compose.lock'),
      home: homedir(),
    };
    await writeFile(this.file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    this.logger.warn(`Created a development config for the root programs in ${this.file}`);
  }
}
