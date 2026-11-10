import type {
  AlertChannel,
  AlertKind,
  AlertSeverity,
  ContainerHealth,
  DeliveryProblem,
} from '@ilex/shared';

/** A problem a rule sees now: an alert should be open for it. */
export interface AlertCondition {
  kind: AlertKind;
  subject: string;
  severity: AlertSeverity;
  details: AlertDetails;
}

/** Stored with an alert: enough to word it. Never logs, values or secrets. */
export interface AlertDetails {
  /** The app (Compose project) a container belongs to. */
  app?: string;
  /** Before apps: the catalog entry (old alerts only). */
  catalogId?: string;
  percent?: number;
}

/** An open alert as the rules see it (to pick up where they left off after a restart). */
export interface OpenAlert extends AlertCondition {
  id: string;
  openedAt: Date;
  acknowledgedAt: Date | null;
  lastSentAt: Date | null;
}

/** What happened to an alert, for the messages. */
export interface AlertEvent {
  type: 'opened' | 'escalated' | 'closed' | 'reminder';
  alert: OpenAlert;
}

/** A container the watcher looks after, as the latest list shows it. */
export interface WatchedContainer {
  name: string;
  /** The app (Compose project) it belongs to; null for the platform's own. */
  app: string | null;
  running: boolean;
  health: ContainerHealth;
}

/** A message to send through every channel switched on. */
export interface AlertMessage {
  title: string;
  body: string;
  /** `resolved`: a closed alert. */
  severity: AlertSeverity | 'resolved';
}

/** One channel's settings, decrypted — only inside the server. */
export type ChannelConfig =
  | {
      kind: 'email';
      host: string;
      port: number;
      username: string;
      password: string | null;
      from: string;
      to: string;
    }
  | { kind: 'ntfy'; topicUrl: string; token: string | null };

/** Sending failed, and why. */
export class DeliveryError extends Error {
  constructor(
    readonly problem: DeliveryProblem,
    message?: string,
  ) {
    super(message ?? `Delivery failed: ${problem}`);
    this.name = 'DeliveryError';
  }
}

/** Sends one message through one kind of channel. */
export interface ChannelSender<C extends ChannelConfig = ChannelConfig> {
  readonly channel: AlertChannel;
  send(config: C, message: AlertMessage): Promise<void>;
}
