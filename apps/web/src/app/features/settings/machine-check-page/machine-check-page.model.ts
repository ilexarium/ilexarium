export type MachineCheckStepId = 'signIn' | 'helper' | 'userUnits' | 'sudo' | 'docker';

export type MachineCheckStatus =
  'waiting' | 'running' | 'ok' | 'failed' | 'info' | 'skipped' | 'not_checked';

/** One row of the page: its status, and the text key saying what it found and what to do. */
export interface MachineCheckStep {
  id: MachineCheckStepId;
  status: MachineCheckStatus;
  text: string;
  /** What to run to fix it, if a command does. */
  command?: string;
}
