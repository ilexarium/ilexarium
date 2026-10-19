/**
 * `offline`: not connected and not trying (signed out). `connecting`: the first attempt.
 * `live`: connected. `reconnecting`: the connection dropped; trying again.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'live' | 'reconnecting';
