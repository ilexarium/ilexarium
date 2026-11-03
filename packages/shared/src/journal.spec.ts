import { describe, expect, it } from 'vitest';
import { journalBootsQuerySchema, journalCursorSchema, journalQuerySchema } from './journal.js';

const CURSOR =
  's=49945bd099a04e9e8641a723e7fcd7be;i=3370d;b=f9f89b85a48e4a8e9fa9736de394a41f;m=5b5d383cf0;t=65f6348db13d7;x=4beaf2b8d8597df1';

describe('journalCursorSchema', () => {
  it('accepts journald’s cursors and nothing that could be more than one argument', () => {
    expect(journalCursorSchema.safeParse(CURSOR).success).toBe(true);
    for (const cursor of ['', 'a b', 'a\nb', 'a,b', '"x"', '../x', 'x'.repeat(513)]) {
      expect(journalCursorSchema.safeParse(cursor).success, cursor).toBe(false);
    }
  });
});

describe('journalQuerySchema', () => {
  it('defaults to info and above, this boot; a flag for reading as administrator', () => {
    expect(journalQuerySchema.parse({})).toEqual({ priority: 'info' });
    expect(
      journalQuerySchema.parse({
        unit: 'nginx.service',
        priority: 'error',
        boot: 'f9f89b85a48e4a8e9fa9736de394a41f',
        after: CURSOR,
        administrator: 'true',
      }),
    ).toEqual({
      unit: 'nginx.service',
      priority: 'error',
      boot: 'f9f89b85a48e4a8e9fa9736de394a41f',
      after: CURSOR,
      administrator: true,
    });
    expect(journalQuerySchema.parse({ boot: '-1' }).boot).toBe('-1');
  });

  it('refuses other units, priorities, boots, both directions and unknown keys', () => {
    for (const query of [
      { unit: 'nginx' },
      { unit: '-x.service' },
      { priority: '3' },
      { boot: '0' },
      { boot: '-2' },
      { boot: 'F9F89B85A48E4A8E9FA9736DE394A41F' },
      { after: CURSOR, before: CURSOR },
      { administrator: 'false' },
      { lines: '10' },
    ]) {
      expect(journalQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
    expect(journalBootsQuerySchema.safeParse({ unit: 'nginx.service' }).success).toBe(false);
  });
});
