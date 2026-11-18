import type { SocketUnit } from './systemd-socket.model.js';

/** The first file descriptor systemd passes a socket in (sd_listen_fds' SD_LISTEN_FDS_START). */
export const FIRST_PASSED_FD = 3;
/** ilex.socket and ilex-https.socket each listen on one address, or two (127.0.0.1 and ::1). */
export const MAX_PASSED_SOCKETS = 4;

export const MOVE_SOCKET_HINT =
  'After a change to HOST or PORT in /etc/ilex/app.env: systemctl daemon-reload && ' +
  'systemctl restart ilex.socket';
export const MOVE_HTTPS_SOCKET_HINT =
  'After a change to HTTPS_HOST or HTTPS_PORT in /etc/ilex/app.env: systemctl daemon-reload && ' +
  'systemctl enable ilex-https.socket && systemctl restart ilex-https.socket ilex — or, for ' +
  'this machine only, remove HTTPS_HOST and: systemctl disable --now ilex-https.socket && ' +
  'systemctl restart ilex';
export const NO_SOCKET_MESSAGE =
  "systemd passed no socket: in production the port is ilex.socket's (systemctl start ilex).";

/**
 * The two socket units and the settings each follows. systemd names every passed socket after
 * its unit (LISTEN_FDNAMES). HTTPS has no default address: unset, it's off.
 */
export const PLAIN_SOCKET: SocketUnit = {
  unit: 'ilex.socket',
  host: 'HOST',
  port: 'PORT',
  defaultHost: '127.0.0.1',
  hint: MOVE_SOCKET_HINT,
};
export const HTTPS_SOCKET: SocketUnit = {
  unit: 'ilex-https.socket',
  host: 'HTTPS_HOST',
  port: 'HTTPS_PORT',
  hint: MOVE_HTTPS_SOCKET_HINT,
};

export const MIN_TLS_VERSION = 'TLSv1.2';
export const HTTPS_OFF_NOTE =
  "HTTPS on the network is off until then; this machine's own port answers as before.";
