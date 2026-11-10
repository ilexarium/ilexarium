import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { ProgramConfigService } from '../root-programs/program-config.js';
import { RELEASE_SETTINGS_DIR, UPDATES_DIR } from './updates.constants.js';

/** Where ilex-update's settings and job files are: the machine's, or development's pretend one. */
@Injectable()
export class UpdatePlaces {
  constructor(private readonly programConfigService: ProgramConfigService) {}

  private get devRoot(): string | null {
    return this.programConfigService.config.update?.dev?.root ?? null;
  }

  /** release.env and release.pub (root-owned in production). */
  get settingsDir(): string {
    const root = this.devRoot;
    return root ? join(root, RELEASE_SETTINGS_DIR) : RELEASE_SETTINGS_DIR;
  }

  get jobsDir(): string {
    const root = this.devRoot;
    return root ? join(root, UPDATES_DIR) : UPDATES_DIR;
  }

  /** Development (tests) also takes releases over plain HTTP from this machine. */
  get development(): boolean {
    return this.devRoot !== null;
  }
}
