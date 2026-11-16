// The installer's /etc/ilex/wrappers.json: the template with this machine's values filled in.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SYSTEM = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(SYSTEM, 'install/wrappers-config.mjs');
const TEMPLATE = join(SYSTEM, 'config/wrappers.json');
const MACHINE = {
  APP_UID: '990',
  APP_GID: '991',
  BORG_BIN: '/usr/bin/borg',
  SSH_UNIT: 'ssh.service',
};

const fill = (env: Record<string, string>, template = TEMPLATE) =>
  spawnSync(process.execPath, [SCRIPT, template], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });

describe('wrappers-config', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('fills in the machine values and keeps everything else as the template has it', () => {
    const result = fill(MACHINE);
    expect(result.status).toBe(0);
    const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    expect(JSON.parse(result.stdout)).toEqual({
      ...template,
      update: { appGid: 991, sshUnit: 'ssh.service' },
      backup: { ...template.backup, borgBin: '/usr/bin/borg', appUid: 990, appGid: 991 },
    });
  });

  it.each([
    ['APP_UID', '99x'],
    ['APP_GID', ''],
    ['BORG_BIN', 'borg'],
    ['BORG_BIN', '/usr/local/../bin/borg'],
    ['BORG_BIN', '/usr/bin/borg --remote-path=x'],
    ['SSH_UNIT', 'evil.service'],
  ])('refuses %s=%j', (name, value) => {
    const result = fill({ ...MACHINE, [name]: value });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(name);
  });

  it('refuses a template with a machine value it does not fill', () => {
    dir = mkdtempSync(join(tmpdir(), 'wrappers-'));
    const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    template.backup.platform.newMachineValue = null;
    const path = join(dir, 'wrappers.json');
    writeFileSync(path, JSON.stringify(template));
    const result = fill(MACHINE, path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('still empty');
  });
});
