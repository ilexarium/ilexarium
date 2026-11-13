import { flattenMessages } from '@ilex/i18n';
import { describe, expect, it } from 'vitest';
import en from '@ilex/i18n/en.json' with { type: 'json' };
import {
  emailChannelFormSchema,
  emailChannelUpdateSchema,
  ntfyChannelFormSchema,
  ntfyChannelUpdateSchema,
  ntfyTopicUrlSchema,
  sameEmailDestination,
} from './alerts.js';

const email = {
  enabled: true,
  host: 'mail.example.com',
  port: 587,
  username: 'alerts',
  password: 'pw',
  from: 'ilex@example.com',
  to: 'me@example.com',
};

describe('alert channel settings', () => {
  it('accepts mail servers on any port, by name or address', () => {
    for (const change of [{ port: 25 }, { port: 465 }, { host: '192.168.1.5' }, { host: '::1' }]) {
      expect(
        emailChannelUpdateSchema.safeParse({ ...email, ...change }).success,
        JSON.stringify(change),
      ).toBe(true);
    }
  });

  it('keeps the stored password when none is sent; the form allows an empty one', () => {
    const { password: _, ...rest } = email;
    expect(emailChannelUpdateSchema.safeParse(rest).success).toBe(true);
    expect(emailChannelUpdateSchema.safeParse({ ...email, password: '' }).success).toBe(false);
    expect(emailChannelFormSchema.safeParse({ ...email, password: '' }).success).toBe(true);
  });

  it('takes a topic URL: http(s), a topic name, no login, query or fragment', () => {
    for (const url of ['https://ntfy.sh/ilex-7f3k9q2m', 'http://192.168.1.20:8080/ntfy/alerts']) {
      expect(ntfyTopicUrlSchema.safeParse(url).success, url).toBe(true);
    }
    for (const url of [
      'ftp://ntfy.sh/topic',
      'https://ntfy.sh/',
      'https://user:pw@ntfy.sh/topic',
      'https://ntfy.sh/topic?x=1',
      'https://ntfy.sh/topic#a',
      'https://ntfy.sh/to pic',
    ]) {
      expect(ntfyTopicUrlSchema.safeParse(url).success, url).toBe(false);
    }
  });

  it('a stored mail password belongs to one server, port and user name', () => {
    const saved = { host: 'mail.example.com', port: 587, username: 'alerts' };
    expect(sameEmailDestination(saved, { ...saved, host: ' MAIL.Example.com ' })).toBe(true);
    for (const change of [
      { host: 'mail.attacker.example' },
      { host: 'mail.example.com.' },
      { port: 465 },
      { username: 'Alerts' },
      { username: '' },
    ]) {
      expect(sameEmailDestination(saved, { ...saved, ...change }), JSON.stringify(change)).toBe(
        false,
      );
    }
  });

  it('ntfy: left out keeps, null removes the token', () => {
    expect(ntfyChannelUpdateSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(ntfyChannelUpdateSchema.safeParse({ enabled: true, token: null }).success).toBe(true);
    expect(ntfyChannelUpdateSchema.safeParse({ enabled: true, token: 'has space' }).success).toBe(
      false,
    );
  });

  it('words every broken rule with a key in en.json', () => {
    const keys = new Set(Object.keys(flattenMessages(en)));
    const broken = [
      emailChannelFormSchema.safeParse({
        enabled: true,
        host: '',
        port: 0,
        username: 'x'.repeat(999),
        password: '\u0001',
        from: '',
        to: 'nope',
      }),
      emailChannelFormSchema.safeParse({
        ...email,
        host: 'bad host!',
        port: 1.5,
        password: 'x'.repeat(999),
      }),
      ntfyChannelFormSchema.safeParse({
        enabled: true,
        topicUrl: 'nope',
        token: 'a b',
        clearToken: false,
      }),
      ntfyChannelFormSchema.safeParse({
        enabled: true,
        topicUrl: 'https://ntfy.sh/',
        token: 'x'.repeat(999),
        clearToken: false,
      }),
    ];
    const messages = new Set(broken.flatMap((r) => r.error?.issues ?? []).map((i) => i.message));
    expect(messages.size).toBeGreaterThanOrEqual(10);
    for (const message of messages) {
      expect(message).toMatch(/^validation\./);
      expect(keys.has(message), message).toBe(true);
    }
  });
});
