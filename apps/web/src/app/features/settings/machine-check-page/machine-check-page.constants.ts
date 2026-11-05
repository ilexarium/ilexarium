import type { MachineCheckStatus, MachineCheckStepId } from './machine-check-page.model';

/** In the order the chain runs; Docker last, from the helper's answer. */
export const STEPS: readonly MachineCheckStepId[] = [
  'signIn',
  'helper',
  'userUnits',
  'sudo',
  'docker',
];

export const STATUS_ICONS: Record<MachineCheckStatus, string> = {
  waiting: 'lucideCircleDashed',
  running: 'lucideLoaderCircle',
  ok: 'lucideCircleCheck',
  failed: 'lucideCircleX',
  info: 'lucideInfo',
  skipped: 'lucideCircleMinus',
  not_checked: 'lucideCircleMinus',
};

export const STATUS_COLORS: Record<MachineCheckStatus, string> = {
  waiting: 'text-muted-foreground',
  running: 'text-muted-foreground animate-spin',
  ok: 'text-success',
  failed: 'text-destructive',
  info: 'text-primary',
  skipped: 'text-muted-foreground',
  not_checked: 'text-muted-foreground',
};

/** The fix as a command (machine text, never translated), by the step's text key. */
export const COMMANDS: Record<string, (account: string) => string> = {
  'helper.unavailable': () => 'sudo ./install.sh',
  'helper.wrong_account': () => 'sudo ./install.sh',
  'userUnits.failed': (account) => `sudo loginctl enable-linger ${account}`,
  'userUnits.noLingering': (account) => `sudo loginctl enable-linger ${account}`,
  'docker.system_units': (account) => `sudo usermod -aG docker ${account}`,
};
