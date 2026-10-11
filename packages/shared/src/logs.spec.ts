import { describe, expect, it } from 'vitest';
import {
  LOG_LIMITS,
  containerNameSchema,
  logLineSchema,
  logsCloseSchema,
  logsEndSchema,
  logsLinesSchema,
  logsOpenSchema,
} from './logs.js';

const line = { at: '2026-10-11T12:00:00.123456789Z', stream: 'stdout', text: 'Server started' };

describe('containerNameSchema', () => {
  it('accepts names Docker and Compose create', () => {
    for (const name of ['jellyfin', 'homelab-dev-postgres-1', 'my_app.web', 'A1', '0abc']) {
      expect(containerNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('rejects anything that could leave the path or isn’t a name', () => {
    for (const name of [
      '',
      '/jellyfin',
      '../json',
      'a/../../b',
      '.hidden',
      '-flag',
      '_x',
      'with space',
      'a?follow=0',
      'a%2F',
      'jellyfin\n',
      'é',
      'a'.repeat(256),
    ]) {
      expect(containerNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
    }
  });

  it('accepts names up to 255 characters', () => {
    expect(containerNameSchema.safeParse('a'.repeat(255)).success).toBe(true);
  });
});

describe('logsOpenSchema', () => {
  it('defaults tail to 500 and leaves since out', () => {
    expect(logsOpenSchema.parse({ container: 'jellyfin' })).toEqual({
      container: 'jellyfin',
      tail: LOG_LIMITS.defaultTail,
    });
    expect(LOG_LIMITS.defaultTail).toBe(500);
  });

  it('accepts tail from 1 to 5,000', () => {
    for (const tail of [1, 500, 5000]) {
      expect(logsOpenSchema.safeParse({ container: 'jellyfin', tail }).success, `${tail}`).toBe(
        true,
      );
    }
  });

  it('rejects tail outside 1–5,000 or not a whole number', () => {
    for (const tail of [0, -1, 5001, 1.5, '500', null, Number.NaN, Infinity]) {
      expect(logsOpenSchema.safeParse({ container: 'jellyfin', tail }).success, `${tail}`).toBe(
        false,
      );
    }
  });

  it('accepts since as Docker’s nanosecond timestamp', () => {
    for (const since of ['2026-10-11T12:00:00.123456789Z', '2026-10-11T12:00:00Z']) {
      expect(logsOpenSchema.safeParse({ container: 'jellyfin', since }).success, since).toBe(true);
    }
  });

  it('rejects since that isn’t an RFC 3339 UTC timestamp', () => {
    for (const since of ['yesterday', '1791720000', 1_791_720_000_000, '2026-10-11', '']) {
      expect(logsOpenSchema.safeParse({ container: 'jellyfin', since }).success, `${since}`).toBe(
        false,
      );
    }
  });

  it('rejects a missing or invalid container name', () => {
    expect(logsOpenSchema.safeParse({ tail: 100 }).success).toBe(false);
    expect(logsOpenSchema.safeParse({ container: '../x' }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    for (const extra of [{ follow: false }, { stdout: false }, { until: line.at }]) {
      const data = { container: 'jellyfin', ...extra };
      expect(logsOpenSchema.safeParse(data).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe('logsCloseSchema', () => {
  it('takes a container name and nothing else', () => {
    expect(logsCloseSchema.safeParse({ container: 'jellyfin' }).success).toBe(true);
    expect(logsCloseSchema.safeParse({}).success).toBe(false);
    expect(logsCloseSchema.safeParse({ container: '../x' }).success).toBe(false);
    expect(logsCloseSchema.safeParse({ container: 'jellyfin', tail: 5 }).success).toBe(false);
  });
});

describe('logLineSchema', () => {
  it('accepts stdout and stderr lines, empty text and truncated lines', () => {
    for (const value of [
      line,
      { ...line, stream: 'stderr' },
      { ...line, text: '' },
      { ...line, truncated: true },
    ]) {
      expect(logLineSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects other streams, a bad timestamp and truncated: false', () => {
    for (const value of [
      { ...line, stream: 'stdin' },
      { ...line, at: 1_791_720_000_000 },
      { ...line, truncated: false },
    ]) {
      expect(logLineSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('logsLinesSchema', () => {
  it('accepts a batch, with or without skipped lines', () => {
    expect(logsLinesSchema.safeParse({ container: 'jellyfin', lines: [line] }).success).toBe(true);
    const flood = { container: 'jellyfin', lines: [line], skipped: 12_000 };
    expect(logsLinesSchema.safeParse(flood).success).toBe(true);
  });

  it('rejects a skipped count that isn’t a positive whole number', () => {
    for (const skipped of [0, -1, 1.5]) {
      const data = { container: 'jellyfin', lines: [line], skipped };
      expect(logsLinesSchema.safeParse(data).success, `${skipped}`).toBe(false);
    }
  });
});

describe('logsEndSchema', () => {
  it('accepts the known reasons only', () => {
    for (const reason of ['stopped', 'removed', 'not_found', 'unavailable', 'error']) {
      expect(logsEndSchema.safeParse({ container: 'jellyfin', reason }).success, reason).toBe(true);
    }
    expect(logsEndSchema.safeParse({ container: 'jellyfin', reason: 'oops' }).success).toBe(false);
  });
});
