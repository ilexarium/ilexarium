import {
  cleanLine,
  LineSplitter,
  MAX_LINE_LENGTH,
  MAX_PENDING_LENGTH,
  maskSecrets,
  parseWrapperLine,
} from './wrapper-output.js';

describe('LineSplitter', () => {
  it('joins lines and characters split across chunks', () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('first\nsecond ü\nthi');
    // Split inside "ü" (two bytes in UTF-8).
    const cut = bytes.indexOf(Buffer.from('ü')) + 1;
    expect(splitter.push(bytes.subarray(0, cut))).toEqual(['first']);
    expect(splitter.push(bytes.subarray(cut))).toEqual(['second ü']);
    expect(splitter.push(Buffer.from('rd'))).toEqual([]);
    expect(splitter.end()).toEqual(['third']);
  });

  it('gives up on a line that never ends instead of keeping it growing', () => {
    const splitter = new LineSplitter();
    const lines = splitter.push(Buffer.from('x'.repeat(MAX_PENDING_LENGTH + 1)));
    expect(lines).toHaveLength(1);
  });

  it('keeps a long line whole while it is still coming (a large result)', () => {
    const splitter = new LineSplitter();
    expect(splitter.push(Buffer.from('y'.repeat(MAX_LINE_LENGTH * 3)))).toEqual([]);
    expect(splitter.push(Buffer.from('\n'))).toEqual(['y'.repeat(MAX_LINE_LENGTH * 3)]);
  });
});

describe('cleanLine', () => {
  it('removes colour codes and control characters, keeps tabs', () => {
    expect(cleanLine('\x1b[32m✔\x1b[0m Container\tStarted\x07\r')).toBe('✔ Container\tStarted');
    expect(cleanLine('\x1b]0;title\x07text')).toBe('text');
  });

  it('cuts very long lines', () => {
    expect(cleanLine('x'.repeat(MAX_LINE_LENGTH + 10))).toHaveLength(MAX_LINE_LENGTH + 1);
  });
});

describe('maskSecrets', () => {
  it('replaces every secret, longest first', () => {
    expect(maskSecrets('pw=abcd1234 db=abcd1234XY abcd1234', ['abcd1234', 'abcd1234XY'])).toBe(
      'pw=•••• db=•••• ••••',
    );
  });

  it('ignores secrets too short to mask meaningfully', () => {
    expect(maskSecrets('a b c', ['a', ''])).toBe('a b c');
  });
});

describe('parseWrapperLine', () => {
  it('reads the markers', () => {
    expect(parseWrapperLine('@@phase pulling')).toEqual({ type: 'phase', phase: 'pulling' });
    expect(parseWrapperLine('@@error code=port_in_use field=WEB_PORT')).toEqual({
      type: 'error',
      code: 'port_in_use',
      field: 'WEB_PORT',
    });
    expect(parseWrapperLine('@@error code=busy')).toEqual({
      type: 'error',
      code: 'busy',
      field: null,
    });
    expect(parseWrapperLine('@@info MEDIA_DIR: does not exist')).toEqual({
      type: 'output',
      text: 'MEDIA_DIR: does not exist',
    });
  });

  it('takes Compose’s lines as output, prefix removed — even ones that look like markers', () => {
    expect(parseWrapperLine('> Pulling immich-server')).toEqual({
      type: 'output',
      text: 'Pulling immich-server',
    });
    expect(parseWrapperLine('> @@phase done')).toEqual({ type: 'output', text: '@@phase done' });
    expect(parseWrapperLine('> @@result {"passphrase":"x"}')).toEqual({
      type: 'output',
      text: '@@result {"passphrase":"x"}',
    });
  });

  it('reads a result: one JSON object', () => {
    expect(parseWrapperLine('@@result {"runId":"r1","status":"ok"}')).toEqual({
      type: 'result',
      value: { runId: 'r1', status: 'ok' },
    });
  });

  it.each([
    '@@phase hacked',
    '@@phase done extra',
    '@@error code=Bad-Code',
    '@@error code=busy; rm -rf /',
    '@@error code=busy field=lower',
    '@@error code=busy field=WEB_PORT extra',
    '@@result not json',
    '@@result [1,2]',
    '@@result null',
  ])('treats a malformed marker as plain output: %j', (line) => {
    expect(parseWrapperLine(line)).toEqual({ type: 'output', text: line });
  });
});
