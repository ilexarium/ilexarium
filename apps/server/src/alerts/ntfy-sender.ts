import type { LookupFunction } from 'node:net';
import { Agent, fetch } from 'undici';
import { DeliveryError } from './alerts.model.js';
import type { AlertMessage, ChannelConfig, ChannelSender } from './alerts.model.js';
import { checkTarget, type Lookup } from './safe-address.js';

/** No answer within this long: given up. */
export const SEND_TIMEOUT_MS = 10_000;

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
 * `Authorization: Bearer`. The address is checked first and connected to as checked (undici's
 * `fetch` with a pinned lookup); redirects are never followed; 10 s at most; the answer's body is
 * never read.
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
    // `fetch` would resolve the name again; this agent connects only to the address checked.
    const dispatcher = new Agent({ connect: { lookup: pinned } });
    let status: number;
    try {
      const response = await fetch(url.origin + url.pathname.slice(0, slash + 1), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.token && { Authorization: `Bearer ${config.token}` }),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        dispatcher,
      });
      status = response.status;
      // Only the status matters: the answer itself is never read.
      await response.body?.cancel();
    } catch (error) {
      throw toDeliveryError(error as Error);
    } finally {
      void dispatcher.destroy().catch(() => undefined);
    }
    if (status >= 200 && status < 300) return;
    if (status === 401 || status === 403) throw new DeliveryError('loginRefused');
    // A redirect isn't followed; a wrong topic or server answers 4xx.
    if (status >= 300 && status < 500)
      throw new DeliveryError('rejected', `ntfy answered ${status}`);
    throw new DeliveryError('failed', `ntfy answered ${status}`);
  }
}

/** `fetch` fails with a TypeError whose `cause` is the network's own error; a timeout as itself. */
function toDeliveryError(thrown: Error): DeliveryError {
  if (thrown.name === 'TimeoutError' || thrown.name === 'AbortError') {
    return new DeliveryError('timedOut');
  }
  const error = (thrown.cause ?? thrown) as NodeJS.ErrnoException;
  if (error.code === 'ETIMEDOUT' || error.code === 'UND_ERR_CONNECT_TIMEOUT') {
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
