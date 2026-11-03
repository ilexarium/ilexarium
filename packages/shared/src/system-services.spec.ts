import { describe, expect, it } from 'vitest';
import {
  systemServiceActionAllowed,
  systemServiceActionParamsSchema,
  systemServiceNameSchema,
  systemServicePath,
  systemServiceProtection,
} from './system-services.js';

describe('systemServiceNameSchema', () => {
  it('accepts service units as systemd names them', () => {
    for (const name of [
      'nginx.service',
      'getty@tty1.service',
      'systemd-fsck@dev-disk-by\\x2duuid-1234.service',
      'proton.VPN.service',
      'a:b_c.service',
    ]) {
      expect(systemServiceNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('refuses other units, options and anything that leaves the path', () => {
    for (const name of [
      'nginx',
      'nginx.socket',
      'docker.timer',
      '-nginx.service',
      '--now.service',
      '../x.service',
      'a/b.service',
      'a b.service',
      'a\nb.service',
      '.service',
      `${'a'.repeat(241)}.service`,
    ]) {
      expect(systemServiceNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('takes only the three actions', () => {
    for (const action of ['start', 'stop', 'restart']) {
      expect(systemServiceActionParamsSchema.safeParse({ name: 'x.service', action }).success).toBe(
        true,
      );
    }
    for (const action of ['enable', 'kill', 'mask', 'reload', 'START']) {
      expect(
        systemServiceActionParamsSchema.safeParse({ name: 'x.service', action }).success,
        action,
      ).toBe(false);
    }
  });

  it('puts the name in the path encoded', () => {
    expect(systemServicePath('getty@tty1.service')).toBe(
      '/api/system/services/getty%40tty1.service',
    );
  });
});

describe('systemServiceProtection', () => {
  it('Laris’s own units and what it runs on: nothing from here', () => {
    for (const name of [
      'docker.service',
      'containerd.service',
      'dbus.service',
      'dbus-broker.service',
      'user@1000.service',
      'laris.service',
      'laris-platform.service',
      'laris-backup-now@1.service',
      'laris-app-music-up-20261028T120000.service',
    ]) {
      expect(systemServiceProtection([name]), name).toBe('laris');
    }
    expect(systemServiceActionAllowed('laris', 'start')).toBe(false);
    expect(systemServiceActionAllowed('laris', 'restart')).toBe(false);
  });

  it('what Laris needs: restarted, never stopped', () => {
    for (const name of [
      'ssh.service',
      'sshd.service',
      'tailscaled.service',
      'systemd-journald.service',
    ]) {
      expect(systemServiceProtection([name]), name).toBe('essential');
    }
    expect(systemServiceActionAllowed('essential', 'stop')).toBe(false);
    expect(systemServiceActionAllowed('essential', 'restart')).toBe(true);
    expect(systemServiceActionAllowed('essential', 'start')).toBe(true);
  });

  it('by any of its names: an alias protects like its unit', () => {
    expect(systemServiceProtection(['openssh.service', 'sshd.service'])).toBe('essential');
    expect(systemServiceProtection(['nginx.service', 'larissa.service'])).toBeNull();
    expect(systemServiceProtection(['sshguard.service', 'dockerd-helper.service'])).toBeNull();
    expect(systemServiceActionAllowed(null, 'stop')).toBe(true);
  });
});
