import { isSameOrigin } from './same-origin.js';

describe('isSameOrigin', () => {
  it('accepts an origin on the same host and port', () => {
    expect(isSameOrigin({ origin: 'https://ilex.home.example', host: 'ilex.home.example' })).toBe(
      true,
    );
    expect(isSameOrigin({ origin: 'http://localhost:4200', host: 'localhost:4200' })).toBe(true);
  });

  it('ignores the case of the host header', () => {
    expect(isSameOrigin({ origin: 'https://ilex.test', host: 'IlEx.test' })).toBe(true);
  });

  it('refuses another host, port or a look-alike', () => {
    for (const origin of [
      'https://evil.example',
      'http://localhost:4201',
      'https://ilex.test.evil.example',
      'https://evil.example/ilex.test',
    ]) {
      const host = origin.includes('localhost') ? 'localhost:4200' : 'ilex.test';
      expect(isSameOrigin({ origin, host }), origin).toBe(false);
    }
  });

  it('refuses a missing or unparseable origin, and a missing host', () => {
    expect(isSameOrigin({ host: 'ilex.test' })).toBe(false);
    expect(isSameOrigin({ origin: 'null', host: 'ilex.test' })).toBe(false);
    expect(isSameOrigin({ origin: 'not a url', host: 'ilex.test' })).toBe(false);
    expect(isSameOrigin({ origin: 'https://ilex.test' })).toBe(false);
  });
});
