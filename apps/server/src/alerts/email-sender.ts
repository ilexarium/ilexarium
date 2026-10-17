import { hostname } from 'node:os';
import { createTransport } from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import { DeliveryError } from './alerts.model.js';
import type { AlertMessage, ChannelConfig, ChannelSender } from './alerts.model.js';
import { SEND_TIMEOUT_MS } from './ntfy-sender.js';
import { checkTarget, type Lookup } from './safe-address.js';

/** The port of implicit TLS (SMTPS); any other port must offer STARTTLS. */
export const IMPLICIT_TLS_PORT = 465;

type EmailConfig = Extract<ChannelConfig, { kind: 'email' }>;

/**
 * Sends by email (docs/plans/health_alerts.md) with nodemailer — **only its SMTP transport**,
 * built here directly: its `sendmail` transport would start a program (against "no dependency
 * runs system commands for us") and is never created (a test pins it). TLS is required (implicit
 * on port 465, STARTTLS on any other) and the certificate checked against the name typed, except
 * to a mail server on this machine. The address is checked first and connected to as checked.
 */
export class EmailSender implements ChannelSender<EmailConfig> {
  readonly channel = 'email';

  constructor(
    private readonly reservedPorts: () => readonly number[],
    private readonly lookup?: Lookup,
  ) {}

  async send(config: EmailConfig, message: AlertMessage): Promise<void> {
    const target = await checkTarget(config.host, config.port, {
      reservedPorts: this.reservedPorts(),
      plain: false,
      lookup: this.lookup,
    });
    const name = config.host.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
    const transport = createTransport(
      new SMTPTransport({
        host: target.address,
        port: config.port,
        secure: config.port === IMPLICIT_TLS_PORT,
        // On this machine the message never leaves it: TLS if offered, any certificate.
        requireTLS: !target.loopback,
        ...(target.address !== name && { servername: name }),
        tls: {
          ...(target.address !== name && { servername: name }),
          minVersion: 'TLSv1.2',
          rejectUnauthorized: !target.loopback,
        },
        ...(config.username && { auth: { user: config.username, pass: config.password ?? '' } }),
        name: hostname(),
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      }),
    );
    try {
      await transport.sendMail({
        from: config.from,
        to: config.to,
        subject: message.title,
        text: message.body,
      });
    } catch (error) {
      throw toDeliveryError(error as Error & { code?: string; responseCode?: number });
    } finally {
      transport.close();
    }
  }
}

function toDeliveryError(error: Error & { code?: string; responseCode?: number }): DeliveryError {
  switch (error.code) {
    case 'EAUTH':
    case 'ENOAUTH':
      return new DeliveryError('loginRefused', error.message);
    case 'ETLS':
      return new DeliveryError('tlsFailed', error.message);
    case 'ETIMEDOUT':
      return new DeliveryError('timedOut', error.message);
    case 'EENVELOPE':
    case 'EMESSAGE':
      return new DeliveryError('rejected', error.message);
    case 'EDNS':
      return new DeliveryError('notFound', error.message);
  }
  if (/certificate|self.signed|TLS|SSL/i.test(error.message)) {
    return new DeliveryError('tlsFailed', error.message);
  }
  if (error.code === 'ECONNECTION' || error.code === 'ESOCKET') {
    return new DeliveryError('unreachable', error.message);
  }
  return new DeliveryError('failed', error.message);
}
