import { join } from 'node:path';

// Tests start it with `node` and a folder of fake programs; installed, the shebang's `env -i`
// empties the environment, so this is never set.
const FAKE_BIN = process.env['LARIS_HELPER_FAKE_BIN'];
const program = (path: string) => (FAKE_BIN ? join(FAKE_BIN, path.split('/').pop()!) : path);

export const PROGRAMS = {
  sudo: program('/usr/bin/sudo'),
  kill: program('/usr/bin/kill'),
};

export const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** One request line; anything longer is refused unread. */
export const LINE_MAX = 64 * 1024;
/** What is kept of a program's output (its first lines say what happened). */
export const OUTPUT_MAX = 16 * 1024;
/** sudo waits a few seconds after a wrong password (PAM's delay). */
export const SUDO_TIMEOUT_MS = 20_000;
export const KILL_TIMEOUT_MS = 10_000;

export const SIGNALS = ['TERM', 'KILL'] as const;
/** Linux's highest PID (`pid_max` at most 2^22). */
export const PID_MAX = 4_194_304;
export const PASSWORD_MAX = 1024;

/** What sudo, sudo-rs and kill say (LC_ALL=C). */
export const MESSAGES = {
  wrongPassword:
    /incorrect password|Sorry, try again|incorrect authentication|authentication failed(?!: interaction required)|no password was provided/i,
  passwordRequired: /a password is required|interaction required/i,
  notAllowed:
    /not in the sudoers|not allowed to (?:run|execute)|may not run sudo|I'm afraid I can't do that/i,
  notFound: /No such process/i,
  notPermitted: /Operation not permitted/i,
};
