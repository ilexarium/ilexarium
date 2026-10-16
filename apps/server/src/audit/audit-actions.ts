/** Every action the audit log may record. New features add theirs here. */
export const AUDIT_ACTIONS = [
  'auth.setup',
  'auth.login',
  'auth.logout',
  'auth.password_change',
  'auth.password_confirm',
  'container.start',
  'container.stop',
  'container.restart',
  'service.deploy',
  'service.remove',
  'backup.configure',
  'backup.init',
  'backup.run',
  'backup.restore',
  'backup.discard',
  'backup.forget',
  'backup.passphrase',
  'disk.mount',
  'disk.unmount',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
