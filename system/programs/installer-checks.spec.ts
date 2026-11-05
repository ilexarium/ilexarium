import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CHECKS = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/checks.sh');
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../install/lib/packages.sh');

// The installer's own functions, fed samples: `source` only defines them.
const call = (fn: string, ...args: string[]) =>
  execFileSync(
    'bash',
    ['-c', 'source "$1"; source "$2"; "${@:3}"', '_', CHECKS, PACKAGES, fn, ...args],
    { encoding: 'utf8' },
  );
const holds = (fn: string, ...args: string[]) =>
  spawnSync('bash', [
    '-c',
    'source "$1"; source "$2"; "${@:3}"',
    '_',
    CHECKS,
    PACKAGES,
    fn,
    ...args,
  ]).status === 0;

describe('the installer’s machine checks', () => {
  it('knows Debian, Ubuntu (apt) and Arch (pacman) from os-release, nothing else', () => {
    expect(call('os_family', 'debian', '12', '')).toBe('apt');
    expect(call('os_family', 'debian', '13', '')).toBe('apt');
    expect(call('os_family', 'ubuntu', '24.04', 'debian')).toBe('apt');
    expect(call('os_family', 'arch', '', '')).toBe('pacman');
    expect(call('os_family', 'archarm', '', 'arch')).toBe('pacman');
    expect(call('os_family', 'endeavouros', '', 'arch')).toBe('pacman');
    expect(call('os_family', 'debian', '11', '')).toBe('');
    expect(call('os_family', 'ubuntu', '22.04', 'debian')).toBe('');
    expect(call('os_family', 'fedora', '41', '')).toBe('');
    expect(call('os_family', 'manjaro-arm', '', 'archlinux')).toBe('');
  });

  it('the CPU as Debian names it, only amd64 and arm64', () => {
    expect(call('cpu_arch', 'x86_64')).toBe('amd64');
    expect(call('cpu_arch', 'aarch64')).toBe('arm64');
    expect(call('cpu_arch', 'armv7l')).toBe('');
    expect(call('cpu_arch', 'riscv64')).toBe('');
  });

  it('compares versions', () => {
    expect(holds('version_ge', '24.5.0', '24.5.0')).toBe(true);
    expect(holds('version_ge', '24.10.0', '24.5.0')).toBe(true);
    expect(holds('version_ge', '25.1.0', '24.5.0')).toBe(true);
    expect(holds('version_ge', '24.4.1', '24.5.0')).toBe(false);
    expect(holds('version_ge', '0.10.0', '0.9.0')).toBe(true);
    expect(holds('version_ge', '0.9.0', '0.10.0')).toBe(false);
    expect(holds('version_ge', '1.4.0', '1.4')).toBe(true);
    expect(holds('version_ge', '1.2.8', '1.4')).toBe(false);
  });

  it('Borg 1.4 or a later 1.x, never 2', () => {
    for (const version of ['1.4', '1.4.0', '1.4.1', '1.5.0'])
      expect(holds('borg_fits', version), version).toBe(true);
    for (const version of ['', '1.2.8', '1.3.0', '2.0.0', '2.0.0b14', '2.1.0'])
      expect(holds('borg_fits', version), version).toBe(false);
  });
});
