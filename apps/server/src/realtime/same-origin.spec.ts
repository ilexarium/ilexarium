import { isSameOrigin } from './same-origin.js';

describe('isSameOrigin', () => {
  it('accepts an origin on the same host and port', () => {
    expect(
      isSameOrigin({ origin: 'https://homelab.example.ts.net', host: 'homelab.example.ts.net' }),
    ).toBe(true);
    expect(isSameOrigin({ origin: 'http://localhost:4200', host: 'localhost:4200' })).toBe(true);
  });

  it('ignores the case of the host header', () => {
    expect(isSameOrigin({ origin: 'https://homelab.test', host: 'HomeLab.test' })).toBe(true);
  });

  it('refuses another host, port or a look-alike', () => {
    for (const origin of [
      'https://evil.example',
      'http://localhost:4201',
      'https://homelab.test.evil.example',
      'https://evil.example/homelab.test',
    ]) {
      const host = origin.includes('localhost') ? 'localhost:4200' : 'homelab.test';
      expect(isSameOrigin({ origin, host }), origin).toBe(false);
    }
  });

  it('refuses a missing or unparseable origin, and a missing host', () => {
    expect(isSameOrigin({ host: 'homelab.test' })).toBe(false);
    expect(isSameOrigin({ origin: 'null', host: 'homelab.test' })).toBe(false);
    expect(isSameOrigin({ origin: 'not a url', host: 'homelab.test' })).toBe(false);
    expect(isSameOrigin({ origin: 'https://homelab.test' })).toBe(false);
  });
});
