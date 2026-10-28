import { describe, expect, it } from 'vitest';
import { envValue, parseEnv, setEnvValues } from './env-file.js';

describe('parseEnv', () => {
  it('reads values as Compose does: quotes, escapes, comments, export', () => {
    const values = parseEnv(
      [
        '# a comment',
        'A=plain',
        "B='single # not a comment'",
        'C="double \\"quoted\\" \\\\ back"',
        'D=value # a comment',
        'export E=exported',
        '',
        'F=',
      ].join('\n'),
    );
    expect(Object.fromEntries(values)).toEqual({
      A: 'plain',
      B: 'single # not a comment',
      C: 'double "quoted" \\ back',
      D: 'value',
      E: 'exported',
      F: '',
    });
  });
});

describe('setEnvValues', () => {
  it('changes a line where it is, adds new ones at the end, keeps the rest', () => {
    const text = '# settings\nA=1\nB=2 # kept\n';
    expect(setEnvValues(text, { A: 'new', C: '3' })).toBe('# settings\nA=new\nB=2 # kept\nC=3\n');
  });

  it('writes values so they read back the same', () => {
    for (const value of ['plain', 'with space', "it's", 'a"b', '$HOME', 'x # y', '']) {
      expect(parseEnv(setEnvValues('', { K: value })).get('K')).toBe(value);
    }
  });

  it('never writes a name that is not one', () => {
    expect(setEnvValues('', { 'A B': 'x', 'A=B': 'y' })).toBe('');
  });

  it('quotes only what needs it', () => {
    expect(envValue('abc-1.2:3@x/y')).toBe('abc-1.2:3@x/y');
    expect(envValue('a b')).toBe("'a b'");
  });
});
