import type { ClientMessage, ServerMessage } from '@homelab/shared';

/**
 * `offline`: not connected and not trying (signed out). `connecting`: the first attempt.
 * `live`: connected. `reconnecting`: the connection dropped; trying again.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'live' | 'reconnecting';

/**
 * A per-viewer stream (container logs), unlike a shared topic: it says what it wants itself.
 * `send` sends only while the socket is open.
 */
export interface RealtimeStream {
  /** The socket is live and the tab visible — (re)send the stream's request. Also after a reconnect. */
  resume(send: (message: ClientMessage) => void): void;
  /** The tab was hidden while the socket is open — close the stream on the server. */
  pause(send: (message: ClientMessage) => void): void;
  /** Every stream message (`logs:*`) — each stream picks its own — and every `error`. */
  receive(message: ServerMessage): void;
}
