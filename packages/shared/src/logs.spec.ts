import { describe, expect, it } from 'vitest';
import {
  LOG_LIMITS,
  containerLogsPath,
  containerLogsQuerySchema,
  containerNameSchema,
  logLineSchema,
  logsEndSchema,
  logsLinesSchema,
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

describe('containerLogsQuerySchema', () => {
  it('defaults tail to 500 and leaves since out', () => {
    expect(containerLogsQuerySchema.parse({})).toEqual({ tail: LOG_LIMITS.defaultTail });
    expect(LOG_LIMITS.defaultTail).toBe(500);
  });

  it('accepts tail from 1 to 5,000, as a query string gives it', () => {
    for (const tail of ['1', '500', '5000', '0500']) {
      expect(containerLogsQuerySchema.parse({ tail }).tail, tail).toBe(Number(tail));
    }
  });

  it('rejects tail outside 1–5,000 or not plain digits', () => {
    for (const tail of [
      '0',
      '-1',
      '5001',
      '1.5',
      '1e3',
      ' 5',
      '0x10',
      '',
      'NaN',
      500,
      ['1', '2'],
    ]) {
      expect(containerLogsQuerySchema.safeParse({ tail }).success, JSON.stringify(tail)).toBe(
        false,
      );
    }
  });

  it('accepts since as Docker’s nanosecond timestamp', () => {
    for (const since of ['2026-10-11T12:00:00.123456789Z', '2026-10-11T12:00:00Z']) {
      expect(containerLogsQuerySchema.safeParse({ since }).success, since).toBe(true);
    }
  });

  it('rejects since that isn’t an RFC 3339 UTC timestamp', () => {
    for (const since of ['yesterday', '1791720000', '2026-10-11', '', ['2026-10-11T12:00:00Z']]) {
      expect(containerLogsQuerySchema.safeParse({ since }).success, `${since}`).toBe(false);
    }
  });

  it('rejects unknown fields', () => {
    for (const extra of [{ follow: '0' }, { stdout: '0' }, { until: line.at }, { name: 'x' }]) {
      expect(containerLogsQuerySchema.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe('containerLogsPath', () => {
  it('puts the encoded name in the path', () => {
    expect(containerLogsPath('jellyfin')).toBe('/api/containers/jellyfin/logs');
    expect(containerLogsPath('a/../b')).toBe('/api/containers/a%2F..%2Fb/logs');
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
  it('accepts a batch of one or more lines', () => {
    expect(logsLinesSchema.safeParse({ lines: [line] }).success).toBe(true);
    expect(logsLinesSchema.safeParse({ lines: [line, line] }).success).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(logsLinesSchema.safeParse({ lines: [] }).success).toBe(false);
  });
});

describe('logsEndSchema', () => {
  it('accepts the known reasons only', () => {
    for (const reason of ['stopped', 'removed', 'not_found', 'unavailable', 'error', 'too_many']) {
      expect(logsEndSchema.safeParse({ reason }).success, reason).toBe(true);
    }
    expect(logsEndSchema.safeParse({ reason: 'oops' }).success).toBe(false);
  });
});
