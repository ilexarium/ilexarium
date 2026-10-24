/**
 * The web app's Content Security Policy (docs/plans/content_security_policy.md): scripts only
 * Laris's own files — no inline script, no `eval`; inline styles allowed (Angular, xterm.js and
 * ECharts make style elements at runtime); images also `blob:` (the profile picture's preview) and
 * `data:`; connections only to this origin (API, WebSockets, log stream); never in a frame.
 */
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};
