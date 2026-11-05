import type { HttpParameterCodec } from '@angular/common/http';

/**
 * Every key and value escaped whole: Angular's own codec leaves `;` and `=` as they are, and a Go
 * reverse proxy in front (tailscale serve, Caddy, Traefik) drops a query pair holding a `;` — a
 * journal cursor, a file named `a;b`.
 */
export const STRICT_QUERY_CODEC: HttpParameterCodec = {
  encodeKey: (key) => encodeURIComponent(key),
  encodeValue: (value) => encodeURIComponent(value),
  decodeKey: (key) => decodeURIComponent(key),
  decodeValue: (value) => decodeURIComponent(value),
};
