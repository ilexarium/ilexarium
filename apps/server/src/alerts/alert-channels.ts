import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ALERT_ERROR_CODES,
  type AlertChannel,
  type AlertChannelsResponse,
  type AlertErrorCode,
  type AlertTestResponse,
  type ApiErrorResponse,
  type DeliveryFailure,
  type DeliveryProblem,
  type EmailChannelUpdate,
  type NtfyChannelUpdate,
} from '@laris/shared';
import { hostname } from 'node:os';
import { type Observable, Subject } from 'rxjs';
import { AuditService } from '../audit/audit.service.js';
import { WrapperConfigService } from '../executor/wrapper-config.js';
import type { AlertChannel as ChannelRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { DeliveryError } from './alerts.model.js';
import type { AlertMessage, ChannelConfig, ChannelSender } from './alerts.model.js';
import { EmailSender } from './email-sender.js';
import { NtfySender } from './ntfy-sender.js';
import { checkTarget, type Lookup } from './safe-address.js';

/** Who changes the settings, for the audit log. */
export interface ChannelActor {
  user: { id: string; username: string };
  ip?: string;
}

interface EmailSettings {
  host: string;
  port: number;
  username: string;
  from: string;
  to: string;
}
interface EmailSecrets {
  password: string | null;
}
interface NtfySecrets {
  /** Null: saved switched off before a topic was ever entered. */
  topicUrl: string | null;
  token: string | null;
}

/** Bound into each encrypted value: one copied to another row won't decrypt. */
const secretContext = (channel: AlertChannel) => `alert-channel:${channel}`;

const STATUS: Partial<Record<AlertErrorCode, HttpStatus>> = {
  [ALERT_ERROR_CODES.channelNotConfigured]: HttpStatus.CONFLICT,
};

function failure(code: AlertErrorCode, message: string, field?: string): HttpException {
  const body: ApiErrorResponse = field
    ? { message: 'Validation failed', code, errors: [{ field, code, message }] }
    : { message, code };
  return new HttpException(body, STATUS[code] ?? HttpStatus.BAD_REQUEST);
}

/**
 * Settings → Notifications (docs/plans/health_alerts.md): email and ntfy, each optional. The ntfy
 * topic URL and token and the mail password are stored encrypted (`SecretsService`) and never go
 * back to the browser. Sends a message through every channel switched on and keeps each one's
 * last problem (cleared when one gets through).
 */
@Injectable()
export class AlertChannels {
  private readonly logger = new Logger(AlertChannels.name);
  private readonly changed = new Subject<void>();
  private reservedPorts: () => readonly number[];
  private lookup: Lookup | undefined;
  private senders: { email: EmailSender; ntfy: NtfySender };

  /** Settings changed, or a channel's last problem did. */
  readonly changes$: Observable<void> = this.changed.asObservable();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly audit: AuditService,
    wrapperConfig: WrapperConfigService,
  ) {
    this.reservedPorts = () => wrapperConfig.config.reservedPorts;
    this.senders = this.createSenders();
  }

  /** For tests: resolve names another way, other reserved ports. */
  useNetwork(lookup: Lookup, reservedPorts: () => readonly number[]): void {
    this.lookup = lookup;
    this.reservedPorts = reservedPorts;
    this.senders = this.createSenders();
  }

  private createSenders() {
    return {
      email: new EmailSender(this.reservedPorts, this.lookup),
      ntfy: new NtfySender(this.reservedPorts, this.lookup),
    };
  }

  async view(): Promise<AlertChannelsResponse> {
    const rows = await this.prisma.alertChannel.findMany();
    const email = rows.find((r) => r.kind === 'email');
    const ntfy = rows.find((r) => r.kind === 'ntfy');
    const emailSettings = email?.settings as EmailSettings | undefined;
    const emailSecrets = email ? this.decrypt<EmailSecrets>(email) : null;
    const ntfySecrets = ntfy ? this.decrypt<NtfySecrets>(ntfy) : null;
    return {
      email:
        email && emailSettings
          ? {
              enabled: email.enabled,
              host: emailSettings.host,
              port: emailSettings.port,
              username: emailSettings.username,
              passwordSet: !!emailSecrets?.password,
              from: emailSettings.from,
              to: emailSettings.to,
              lastFailure: lastFailure(email),
            }
          : null,
      ntfy: ntfy
        ? {
            enabled: ntfy.enabled,
            topicSet: !!ntfySecrets?.topicUrl,
            tokenSet: !!ntfySecrets?.token,
            lastFailure: lastFailure(ntfy),
          }
        : null,
    };
  }

  async updateEmail(update: EmailChannelUpdate, actor: ChannelActor): Promise<void> {
    const existing = await this.prisma.alertChannel.findUnique({ where: { kind: 'email' } });
    const stored = existing ? this.decrypt<EmailSecrets>(existing) : null;
    const password = update.username ? (update.password ?? stored?.password ?? null) : null;
    if (update.username && !password) {
      throw failure(ALERT_ERROR_CODES.passwordRequired, 'Enter the password', 'password');
    }
    await this.refuseAddress(update.host, update.port, false, 'host');
    const settings: EmailSettings = {
      host: update.host,
      port: update.port,
      username: update.username,
      from: update.from,
      to: update.to,
    };
    await this.save('email', update.enabled, { ...settings }, { password } satisfies EmailSecrets);
    await this.audit.record({
      action: 'alerts.channel.update',
      outcome: 'success',
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { channel: 'email', enabled: update.enabled },
    });
  }

  async updateNtfy(update: NtfyChannelUpdate, actor: ChannelActor): Promise<void> {
    const existing = await this.prisma.alertChannel.findUnique({ where: { kind: 'ntfy' } });
    const stored = existing ? this.decrypt<NtfySecrets>(existing) : null;
    const topicUrl = update.topicUrl ?? stored?.topicUrl ?? null;
    if (update.enabled && !topicUrl) {
      throw failure(ALERT_ERROR_CODES.topicRequired, 'Enter the topic URL', 'topicUrl');
    }
    if (update.topicUrl) {
      const url = new URL(update.topicUrl);
      const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
      await this.refuseAddress(url.hostname, port, url.protocol === 'http:', 'topicUrl');
    }
    const token = update.token === undefined ? (stored?.token ?? null) : update.token;
    await this.save('ntfy', update.enabled, {}, { topicUrl, token } satisfies NtfySecrets);
    await this.audit.record({
      action: 'alerts.channel.update',
      outcome: 'success',
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { channel: 'ntfy', enabled: update.enabled },
    });
  }

  /** "Send a test": through this channel, switched on or not. */
  async test(channel: AlertChannel, actor: ChannelActor): Promise<AlertTestResponse> {
    const row = await this.prisma.alertChannel.findUnique({ where: { kind: channel } });
    const config = row ? this.config(row) : null;
    if (!config) {
      throw failure(ALERT_ERROR_CODES.channelNotConfigured, 'Save the settings first');
    }
    const problem = await this.sendTo(config, {
      title: 'Test message',
      body: `On ${hostname()}: alerts will reach you this way.`,
      severity: 'warning',
    });
    await this.audit.tryRecord({
      action: 'alerts.channel.test',
      outcome: problem ? 'failure' : 'success',
      userId: actor.user.id,
      username: actor.user.username,
      ip: actor.ip,
      details: { channel, ...(problem && { problem }) },
    });
    return { sent: problem === null, problem };
  }

  /** The channels switched on, decrypted. */
  async enabled(): Promise<ChannelConfig[]> {
    const rows = await this.prisma.alertChannel.findMany({ where: { enabled: true } });
    return rows.map((row) => this.config(row)).filter((config) => config !== null);
  }

  /** Sends through one channel; records the problem (or clears the last one). Null when sent. */
  async sendTo(config: ChannelConfig, message: AlertMessage): Promise<DeliveryProblem | null> {
    const sender = this.senders[config.kind] as ChannelSender;
    let problem: DeliveryProblem | null = null;
    try {
      await sender.send(config, message);
    } catch (error) {
      problem = error instanceof DeliveryError ? error.problem : 'failed';
      this.logger.warn(`A message couldn't be sent by ${config.kind}: ${(error as Error).message}`);
    }
    try {
      const row = await this.prisma.alertChannel.findUnique({ where: { kind: config.kind } });
      if (row && (problem !== null || row.lastProblem !== null)) {
        await this.prisma.alertChannel.update({
          where: { kind: config.kind },
          data: problem
            ? { lastProblem: problem, lastProblemAt: new Date() }
            : { lastProblem: null, lastProblemAt: null },
        });
        this.changed.next();
      }
    } catch (error) {
      this.logger.error('Recording a delivery problem failed', (error as Error).stack);
    }
    return problem;
  }

  /** The latest failed delivery of a channel switched on, or null. */
  async deliveryFailure(): Promise<DeliveryFailure | null> {
    const rows = await this.prisma.alertChannel.findMany({
      where: { enabled: true, lastProblem: { not: null } },
      orderBy: { lastProblemAt: 'desc' },
      take: 1,
    });
    return rows[0] ? lastFailure(rows[0]) : null;
  }

  /** Refuses an address the app never sends to, at once; a name that doesn't resolve (yet) is fine. */
  private async refuseAddress(host: string, port: number, plain: boolean, field: string) {
    try {
      // The senders check again when sending (a name can point elsewhere later).
      await checkTarget(host, port, {
        reservedPorts: this.reservedPorts(),
        plain,
        lookup: this.lookup,
      });
    } catch (error) {
      if (error instanceof DeliveryError && error.problem === 'addressRefused') {
        throw failure(ALERT_ERROR_CODES.addressRefused, 'The app never sends there', field);
      }
    }
  }

  private async save(
    channel: AlertChannel,
    enabled: boolean,
    settings: Record<string, string | number>,
    secrets: EmailSecrets | NtfySecrets,
  ): Promise<void> {
    const encrypted = new Uint8Array(
      this.secrets.encrypt(JSON.stringify(secrets), secretContext(channel)),
    );
    await this.prisma.alertChannel.upsert({
      where: { kind: channel },
      create: { kind: channel, enabled, settings, secrets: encrypted },
      // New settings: the last problem was about the old ones.
      update: { enabled, settings, secrets: encrypted, lastProblem: null, lastProblemAt: null },
    });
    this.changed.next();
  }

  private decrypt<T>(row: ChannelRow): T | null {
    if (!row.secrets) return null;
    try {
      return JSON.parse(
        this.secrets.decrypt(row.secrets, secretContext(row.kind as AlertChannel)),
      ) as T;
    } catch (error) {
      this.logger.error(`The ${row.kind} settings can't be decrypted: ${(error as Error).message}`);
      return null;
    }
  }

  private config(row: ChannelRow): ChannelConfig | null {
    if (row.kind === 'email') {
      const settings = row.settings as unknown as EmailSettings;
      const secrets = this.decrypt<EmailSecrets>(row);
      if (!secrets) return null;
      return { kind: 'email', ...settings, password: secrets.password };
    }
    if (row.kind === 'ntfy') {
      const secrets = this.decrypt<NtfySecrets>(row);
      if (!secrets?.topicUrl) return null;
      return { kind: 'ntfy', topicUrl: secrets.topicUrl, token: secrets.token };
    }
    return null;
  }
}

function lastFailure(row: ChannelRow): DeliveryFailure | null {
  if (!row.lastProblem || !row.lastProblemAt) return null;
  return {
    channel: row.kind as AlertChannel,
    at: row.lastProblemAt.toISOString(),
    problem: row.lastProblem as DeliveryProblem,
  };
}
