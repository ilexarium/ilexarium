import { HttpException } from '@nestjs/common';
import type { EmailChannelUpdate, NtfyChannelUpdate } from '@ilex/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import type { AlertChannel as ChannelRow } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SecretsService } from '../secrets/secrets.service.js';
import { AlertChannels, type ChannelActor } from './alert-channels.js';
import type { ChannelConfig } from './alerts.model.js';
import { EmailSender } from './email-sender.js';
import { NtfySender } from './ntfy-sender.js';

// Every name is "resolved" to a public address: no DNS in unit tests.
vi.mock('./safe-address.js', () => ({
  checkTarget: vi.fn(async () => ({ address: '192.0.2.10', family: 4, loopback: false })),
}));

const ACTOR: ChannelActor = { user: { id: 'u1', username: 'owner' }, ip: '127.0.0.1' };

const EMAIL: EmailChannelUpdate = {
  enabled: true,
  host: 'mail.example.com',
  port: 587,
  username: 'alerts',
  password: 'mail-password',
  from: 'ilex@example.com',
  to: 'me@example.com',
};
const { password: _, ...EMAIL_WITHOUT_PASSWORD } = EMAIL;

const TOPIC = 'https://ntfy.example.com/ilex-alerts';
const NTFY: NtfyChannelUpdate = { enabled: true, topicUrl: TOPIC, token: 'tk_secret' };

/** The refusal an update ended with: status and body. */
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HttpException);
  return {
    status: (error as HttpException).getStatus(),
    body: (error as HttpException).getResponse(),
  };
}

describe('AlertChannels: a stored secret goes only where it was entered for', () => {
  let rows: Map<string, ChannelRow>;
  let audits: AuditEntry[];
  let sent: ChannelConfig[];
  let alertChannels: AlertChannels;

  beforeEach(() => {
    rows = new Map();
    audits = [];
    sent = [];
    const prisma = {
      alertChannel: {
        findUnique: async ({ where }: { where: { kind: string } }) => rows.get(where.kind) ?? null,
        findMany: async () => [...rows.values()],
        update: async () => undefined,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { kind: string };
          create: Partial<ChannelRow>;
          update: Partial<ChannelRow>;
        }) => {
          const old = rows.get(where.kind);
          rows.set(where.kind, {
            lastProblem: null,
            lastProblemAt: null,
            ...(old ?? create),
            ...(old && update),
          } as ChannelRow);
        },
      },
    } as unknown as PrismaService;
    const secretsService = {
      encrypt: (text: string, context: string) => Buffer.from(`${context}|${text}`),
      decrypt: (bytes: Uint8Array, context: string) => {
        const text = Buffer.from(bytes).toString();
        if (!text.startsWith(`${context}|`)) throw new Error('wrong context');
        return text.slice(context.length + 1);
      },
    } as unknown as SecretsService;
    const auditService = {
      record: async (entry: AuditEntry) => void audits.push(entry),
      tryRecord: async (entry: AuditEntry) => void audits.push(entry),
    } as unknown as AuditService;
    const capture = async (config: ChannelConfig) => void sent.push(config);
    vi.spyOn(EmailSender.prototype, 'send').mockImplementation(capture);
    vi.spyOn(NtfySender.prototype, 'send').mockImplementation(capture);
    alertChannels = new AlertChannels(prisma, secretsService, auditService);
  });

  afterEach(() => vi.restoreAllMocks());

  const updates = () =>
    audits.filter((a) => a.action === 'alerts.channel.update').map((a) => a.details);

  describe('email', () => {
    beforeEach(async () => {
      await alertChannels.updateEmail(EMAIL, ACTOR);
    });

    it('keeps the stored password while server, port and user name stay', async () => {
      await alertChannels.updateEmail(
        { ...EMAIL_WITHOUT_PASSWORD, enabled: false, from: 'x@example.com', to: 'y@example.com' },
        ACTOR,
      );
      // A name differs only in case: the same server.
      await alertChannels.updateEmail(
        { ...EMAIL_WITHOUT_PASSWORD, host: 'MAIL.Example.com' },
        ACTOR,
      );
      await alertChannels.test('email', ACTOR);
      expect(sent).toEqual([
        expect.objectContaining({ host: 'MAIL.Example.com', password: 'mail-password' }),
      ]);
      expect(updates()).toEqual([
        { channel: 'email', enabled: true, destinationChanged: true },
        { channel: 'email', enabled: false, destinationChanged: false },
        { channel: 'email', enabled: true, destinationChanged: false },
      ]);
    });

    it('refuses another server, port or user name without the password; nothing is saved or sent there', async () => {
      for (const change of [
        { host: 'mail.attacker.example' },
        { host: 'mail.example.com.' },
        { host: '192.0.2.10' },
        { port: 465 },
        { username: 'someone-else' },
      ]) {
        expect(
          await refusal(alertChannels.updateEmail({ ...EMAIL_WITHOUT_PASSWORD, ...change }, ACTOR)),
          JSON.stringify(change),
        ).toEqual({
          status: 400,
          body: {
            message: 'Validation failed',
            code: 'password_required',
            errors: [
              { field: 'password', code: 'password_required', message: 'Enter the password' },
            ],
          },
        });
      }
      expect(updates()).toHaveLength(1);
      await alertChannels.test('email', ACTOR);
      expect(sent).toEqual([
        expect.objectContaining({
          host: 'mail.example.com',
          port: 587,
          username: 'alerts',
          password: 'mail-password',
        }),
      ]);
    });

    it('saves another server with the password entered for it', async () => {
      await alertChannels.updateEmail(
        { ...EMAIL, host: 'smtp.other.example', port: 465, password: 'other-password' },
        ACTOR,
      );
      await alertChannels.test('email', ACTOR);
      expect(sent).toEqual([
        expect.objectContaining({
          host: 'smtp.other.example',
          port: 465,
          password: 'other-password',
        }),
      ]);
      expect(updates()[1]).toEqual({ channel: 'email', enabled: true, destinationChanged: true });
    });

    it('a server without a login drops the password, wherever it is', async () => {
      await alertChannels.updateEmail(
        { ...EMAIL_WITHOUT_PASSWORD, host: 'relay.lan', username: '' },
        ACTOR,
      );
      await alertChannels.test('email', ACTOR);
      expect(sent).toEqual([
        expect.objectContaining({ host: 'relay.lan', username: '', password: null }),
      ]);
      expect((await alertChannels.view()).email).toMatchObject({ passwordSet: false });
    });
  });

  describe('ntfy', () => {
    it('keeps the token for another topic on the same server', async () => {
      await alertChannels.updateNtfy(NTFY, ACTOR);
      await alertChannels.updateNtfy({ enabled: false }, ACTOR);
      await alertChannels.updateNtfy(
        { enabled: true, topicUrl: 'https://NTFY.example.com:443/other-topic' },
        ACTOR,
      );
      await alertChannels.test('ntfy', ACTOR);
      expect(sent).toEqual([
        {
          kind: 'ntfy',
          topicUrl: 'https://NTFY.example.com:443/other-topic',
          token: 'tk_secret',
        },
      ]);
      expect(updates()).toEqual([
        { channel: 'ntfy', enabled: true, destinationChanged: true },
        { channel: 'ntfy', enabled: false, destinationChanged: false },
        { channel: 'ntfy', enabled: true, destinationChanged: false },
      ]);
    });

    it('refuses a topic URL on another server without the token; nothing is saved or sent there', async () => {
      await alertChannels.updateNtfy(NTFY, ACTOR);
      for (const topicUrl of [
        'https://attacker.example/ilex-alerts',
        'http://ntfy.example.com/ilex-alerts',
        'https://ntfy.example.com:8443/ilex-alerts',
        'https://ntfy.example.com./ilex-alerts',
      ]) {
        expect(
          await refusal(alertChannels.updateNtfy({ enabled: true, topicUrl }, ACTOR)),
          topicUrl,
        ).toEqual({
          status: 400,
          body: {
            message: 'Validation failed',
            code: 'token_required',
            errors: [
              {
                field: 'token',
                code: 'token_required',
                message: 'Enter the token again, or remove it',
              },
            ],
          },
        });
      }
      expect(updates()).toHaveLength(1);
      await alertChannels.test('ntfy', ACTOR);
      expect(sent).toEqual([{ kind: 'ntfy', topicUrl: TOPIC, token: 'tk_secret' }]);
    });

    it('binds the token to the address it is posted to: the URL up to the topic', async () => {
      const proxied = 'https://home.example/ntfy/ilex-alerts';
      await alertChannels.updateNtfy({ ...NTFY, topicUrl: proxied }, ACTOR);
      // Another app may answer elsewhere on the same origin (a proxy routing by path).
      for (const topicUrl of [
        'https://home.example/ilex-alerts',
        'https://home.example/other/ilex-alerts',
        'https://home.example/ntfy/sub/ilex-alerts',
        'https://home.example/ntfy//ilex-alerts',
        'https://home.example/%6Etfy/ilex-alerts',
      ]) {
        expect(
          (await refusal(alertChannels.updateNtfy({ enabled: true, topicUrl }, ACTOR))).body,
          topicUrl,
        ).toMatchObject({ code: 'token_required' });
      }
      // Another topic under the same address keeps it; dot segments are resolved as the URL is.
      await alertChannels.updateNtfy(
        { enabled: true, topicUrl: 'https://home.example/x/../ntfy/other-topic' },
        ACTOR,
      );
      await alertChannels.test('ntfy', ACTOR);
      expect(sent).toEqual([
        {
          kind: 'ntfy',
          topicUrl: 'https://home.example/x/../ntfy/other-topic',
          token: 'tk_secret',
        },
      ]);
      expect(updates().map((details) => details?.destinationChanged)).toEqual([true, false]);
    });

    it('a token saved before any topic URL is entered again with the first one', async () => {
      await alertChannels.updateNtfy({ enabled: false, token: 'tk_secret' }, ACTOR);
      expect(
        (await refusal(alertChannels.updateNtfy({ enabled: true, topicUrl: TOPIC }, ACTOR))).body,
      ).toMatchObject({ code: 'token_required' });
    });

    it('another server with a new token, or with the token removed', async () => {
      await alertChannels.updateNtfy(NTFY, ACTOR);
      await alertChannels.updateNtfy(
        { enabled: true, topicUrl: 'https://push.other.example/alerts', token: 'tk_other' },
        ACTOR,
      );
      await alertChannels.test('ntfy', ACTOR);
      await alertChannels.updateNtfy(
        { enabled: true, topicUrl: 'https://ntfy.sh/ilex-alerts', token: null },
        ACTOR,
      );
      await alertChannels.test('ntfy', ACTOR);
      expect(sent).toEqual([
        { kind: 'ntfy', topicUrl: 'https://push.other.example/alerts', token: 'tk_other' },
        { kind: 'ntfy', topicUrl: 'https://ntfy.sh/ilex-alerts', token: null },
      ]);
    });

    it('without a stored token any server is fine', async () => {
      await alertChannels.updateNtfy({ enabled: true, topicUrl: TOPIC }, ACTOR);
      await alertChannels.updateNtfy(
        { enabled: true, topicUrl: 'https://ntfy.sh/ilex-alerts' },
        ACTOR,
      );
      await alertChannels.test('ntfy', ACTOR);
      expect(sent).toEqual([
        { kind: 'ntfy', topicUrl: 'https://ntfy.sh/ilex-alerts', token: null },
      ]);
    });
  });
});
