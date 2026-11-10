import { HttpClient } from '@angular/common/http';
import { DOCUMENT, inject, Service } from '@angular/core';
import { TERMINAL_PATH, type TerminalTicket } from '@ilex/shared';
import type { Observable } from 'rxjs';
import { WEB_SOCKET_FACTORY } from '../realtime/realtime-service';

/** The web terminal: a ticket (the app password again), then its own socket. */
@Service()
export class TerminalApi {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly createSocket = inject(WEB_SOCKET_FACTORY);

  ticket(password: string): Observable<TerminalTicket> {
    return this.http.post<TerminalTicket>('/api/terminal/ticket', { password });
  }

  /** The terminal's socket, binary frames as `ArrayBuffer`s. */
  open(ticket: string, size: { cols: number; rows: number }): WebSocket {
    const { protocol, host } = this.document.location;
    const query = new URLSearchParams({
      ticket,
      cols: String(size.cols),
      rows: String(size.rows),
    });
    const socket = this.createSocket(
      `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${TERMINAL_PATH}?${query.toString()}`,
    );
    socket.binaryType = 'arraybuffer';
    return socket;
  }
}
