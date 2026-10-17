import * as nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import { FakeSmtp } from '../../test/fake-notifiers.js';
import { EmailSender } from './email-sender.js';
import type { ChannelConfig } from './alerts.model.js';
import type { Lookup } from './safe-address.js';

vi.mock('nodemailer', { spy: true });

type EmailConfig = Extract<ChannelConfig, { kind: 'email' }>;
const MESSAGE = {
  title: 'Immich has stopped',
  body: 'On box, since 14:02.',
  severity: 'critical' as const,
};

describe('EmailSender', () => {
  let smtp: FakeSmtp;
  const config = (overrides: Partial<EmailConfig> = {}): EmailConfig => ({
    kind: 'email',
    host: '127.0.0.1',
    port: smtp.port,
    username: 'alerts',
    password: 'mail-pw',
    from: 'homelab@example.com',
    to: 'me@example.com',
    ...overrides,
  });

  beforeEach(async () => {
    vi.mocked(nodemailer.createTransport).mockClear();
    smtp = await new FakeSmtp({ user: 'alerts', pass: 'mail-pw' }).listen();
  });
  afterEach(() => smtp.close());

  it('sends a mail through a mail server on this machine (no TLS needed there)', async () => {
    await new EmailSender(() => [22]).send(config(), MESSAGE);
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]).toMatchObject({
      from: 'homelab@example.com',
      to: ['me@example.com'],
      user: 'alerts',
    });
    expect(smtp.mails[0].data).toContain('Subject: Immich has stopped');
    expect(smtp.mails[0].data).toContain('On box, since 14:02.');
  });

  it('a wrong password: loginRefused', async () => {
    await expect(
      new EmailSender(() => [22]).send(config({ password: 'wrong' }), MESSAGE),
    ).rejects.toMatchObject({
      problem: 'loginRefused',
    });
  });

  it('only ever creates nodemailer’s SMTP transport', async () => {
    await new EmailSender(() => [22]).send(config(), MESSAGE);
    const created = vi
      .mocked(nodemailer.createTransport)
      .mock.calls.map(([transport]) => transport);
    expect(created).toHaveLength(1);
    expect(created[0]).toBeInstanceOf(SMTPTransport);
  });

  it('requires TLS and checks the certificate against the name typed, except on this machine', async () => {
    const lan: Lookup = async () => [{ address: '192.168.1.5', family: 4 }];
    const sender = new EmailSender(() => [22], lan);
    // Nothing is there: the transport's options are what matter, so sending is left out.
    const offline = { sendMail: async () => ({}), close: () => undefined };
    vi.mocked(nodemailer.createTransport)
      .mockImplementationOnce(() => offline as never)
      .mockImplementationOnce(() => offline as never);
    await sender.send(config({ host: 'mail.home.arpa', port: 587 }), MESSAGE);
    await sender.send(config({ host: 'mail.home.arpa', port: 465 }), MESSAGE);
    await new EmailSender(() => [22]).send(config(), MESSAGE);
    const options = vi
      .mocked(nodemailer.createTransport)
      .mock.calls.map(([transport]) => (transport as SMTPTransport).options);
    expect(options[0]).toMatchObject({
      host: '192.168.1.5',
      port: 587,
      secure: false,
      requireTLS: true,
      servername: 'mail.home.arpa',
      tls: { servername: 'mail.home.arpa', rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
    expect(options[1]).toMatchObject({ port: 465, secure: true, requireTLS: true });
    expect(options[2]).toMatchObject({
      host: '127.0.0.1',
      requireTLS: false,
      tls: { rejectUnauthorized: false },
    });
    for (const option of options) {
      expect(option).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
      expect(option).not.toHaveProperty('sendmail');
    }
  });

  it('refuses the platform’s own ports and link-local addresses before connecting', async () => {
    await expect(new EmailSender(() => [smtp.port]).send(config(), MESSAGE)).rejects.toMatchObject({
      problem: 'addressRefused',
    });
    await expect(
      new EmailSender(() => [22]).send(config({ host: '169.254.169.254', port: 25 }), MESSAGE),
    ).rejects.toMatchObject({ problem: 'addressRefused' });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('no user name: no login', async () => {
    const open = await new FakeSmtp().listen();
    try {
      await new EmailSender(() => [22]).send(
        config({ port: open.port, username: '', password: null }),
        MESSAGE,
      );
      expect(open.mails[0].user).toBeNull();
    } finally {
      await open.close();
    }
  });
});
