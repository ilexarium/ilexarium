/** The first file descriptor systemd passes a socket in (sd_listen_fds' SD_LISTEN_FDS_START). */
export const FIRST_PASSED_FD = 3;
/** ilex.socket listens on one address, or two (127.0.0.1 and ::1). */
export const MAX_PASSED_SOCKETS = 2;

export const MOVE_SOCKET_HINT =
  'After a change to HOST or PORT in /etc/ilex/app.env: systemctl daemon-reload && ' +
  'systemctl restart ilex.socket';
