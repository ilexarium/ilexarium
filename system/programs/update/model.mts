export interface Config {
  update: {
    appGid?: number;
    // Development only (tests): a pretend machine under `root`, programs from `bin`.
    dev?: { root: string; bin: string; healthUrl: string };
  };
}

export interface Paths {
  /** /etc/laris: release.env, release.pub, version. */
  etc: string;
  /** /opt/laris: the install, and previous/ — the way back. */
  opt: string;
  /** Job files and each update's download folder. */
  state: string;
  /** The installer's database dumps (it names the one it made). */
  installBackups: string;
  units: string;
  /** Where previous/files/ goes back to: `/`, or the pretend machine. */
  host: string;
  lock: string;
  healthUrl: string;
}

export interface Programs {
  systemctl: string;
  tmpfiles: string;
  tar: string;
  bash: string;
  cp: string;
  docker: string;
}

export interface Manifest {
  version: string;
  published: string;
  archive: string;
  sha256: string;
  size: number;
  notes?: string;
}

export type Outcome = 'updated' | 'failed' | 'rolled_back' | 'rollback_failed';
