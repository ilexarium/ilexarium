import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { DeliveryError } from './alerts.model.js';
import type { AlertMessage, ChannelConfig, ChannelSender } from './alerts.model.js';
import { checkTarget, type Lookup } from './safe-address.js';

/** No answer within this long: given up. */
export const SEND_TIMEOUT_MS = 10_000;
/** Of the answer, at most this much is read (only its status matters). */
const MAX_RESPONSE_BYTES = 16 * 1024;

/** ntfy's priorities: 4 high, 3 default, 2 low. */
const PRIORITY: Record<AlertMessage['severity'], number> = { critical: 4, warning: 3, resolved: 2 };
const TAGS: Record<AlertMessage['severity'], string> = {
  critical: 'rotating_light',
  warning: 'warning',
  resolved: 'white_check_mark',
};

type NtfyConfig = Extract<ChannelConfig, { kind: 'ntfy' }>;

/**
 * Sends to an ntfy topic (docs/plans/health_alerts.md): one JSON POST to the server
 * (`{ topic, title, message, priority, tags }` — JSON so any text fits), the token as
 * `Authorization: Bearer`. The address is checked first and connected to as checked; redirects
 * are never followed; 10 s at most; the answer's body is barely read.
 */
export class NtfySender implements ChannelSender<NtfyConfig> {
  readonly channel = 'ntfy';

  constructor(
    private readonly reservedPorts: () => readonly number[],
    private readonly lookup?: Lookup,
    private readonly timeoutMs = SEND_TIMEOUT_MS,
  ) {}

  async send(config: NtfyConfig, message: AlertMessage): Promise<void> {
    const url = new URL(config.topicUrl);
    const secure = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const target = await checkTarget(url.hostname, port, {
      reservedPorts: this.reservedPorts(),
      plain: !secure,
      lookup: this.lookup,
    });
    // The topic is the URL's last part; JSON is posted to the server's root (or its subpath).
    const slash = url.pathname.lastIndexOf('/');
    const topic = url.pathname.slice(slash + 1);
    const body = JSON.stringify({
      topic,
      title: message.title,
      message: message.body,
      priority: PRIORITY[message.severity],
      tags: [TAGS[message.severity]],
    });
    // The checked address, never a second lookup (a name could answer differently the second time).
    const pinned: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    const status = await new Promise<number>((resolve, reject) => {
      const req = (secure ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
          port,
          path: url.pathname.slice(0, slash + 1),
          method: 'POST',
          lookup: pinned,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(config.token && { Authorization: `Bearer ${config.token}` }),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
          agent: false,
        },
        (res: IncomingMessage) => {
          let read = 0;
          res.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > MAX_RESPONSE_BYTES) res.destroy();
          });
          res.on('close', () => resolve(res.statusCode ?? 0));
          res.on('error', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => reject(toDeliveryError(error)));
      req.end(body);
    });
    if (status >= 200 && status < 300) return;
    if (status === 401 || status === 403) throw new DeliveryError('loginRefused');
    // A redirect isn't followed; a wrong topic or server answers 4xx.
    if (status >= 300 && status < 500)
      throw new DeliveryError('rejected', `ntfy answered ${status}`);
    throw new DeliveryError('failed', `ntfy answered ${status}`);
  }
}

function toDeliveryError(error: NodeJS.ErrnoException): DeliveryError {
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
    return new DeliveryError('timedOut');
  }
  if (error.code?.startsWith('ERR_TLS') || /certificate|SSL|TLS/i.test(error.message)) {
    return new DeliveryError('tlsFailed', error.message);
  }
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(error.code ?? '')) {
    return new DeliveryError('unreachable', error.message);
  }
  return new DeliveryError('failed', error.message);
}
