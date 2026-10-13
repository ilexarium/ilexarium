/** Every action the audit log may record. New features add theirs here. */
export const AUDIT_ACTIONS = [
  'auth.setup',
  'auth.login',
  'auth.logout',
  'auth.password_change',
  'container.start',
  'container.stop',
  'container.restart',
  'service.deploy',
  'service.remove',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
