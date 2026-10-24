import helmet from 'helmet';
import { CSP_DIRECTIVES } from './security-headers.constants.js';

/**
 * Security headers on every response (`helmet`), each one chosen here rather than left to its
 * defaults. A response may set a stricter CSP of its own (downloads, the profile picture).
 */
export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    originAgentCluster: true,
    // Not `no-referrer`: with it, browsers send `Origin: null` on the app's own writes, and the
    // CSRF check (Origin against Host, where `Sec-Fetch-Site` is missing) refuses them.
    referrerPolicy: { policy: 'same-origin' },
    // HTTPS is the front's job (`tailscale serve`, or a proxy of the person's own): a year of
    // HSTS sent by the app would bind that host name — and with subdomains, others — to HTTPS.
    strictTransportSecurity: false,
    xContentTypeOptions: true,
    xDnsPrefetchControl: { allow: false },
    xDownloadOptions: true,
    xFrameOptions: { action: 'deny' },
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xPoweredBy: true,
    xXssProtection: true,
  });
}
