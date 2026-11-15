import { clientKey } from './client-key.js';

describe('clientKey', () => {
  it('keeps an IPv4 address as it is', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups public IPv6 addresses by their /64, however they are written', () => {
    const key = '2001:db8:aa:1::/64';
    expect(clientKey('2001:db8:aa:1::1')).toBe(key);
    expect(clientKey('2001:0db8:00aa:0001:ffff:ffff:ffff:ffff')).toBe(key);
    expect(clientKey('2001:DB8:AA:1:1234:5678::')).toBe(key);
    expect(clientKey('2001:db8:aa:1::1%eth0')).toBe(key);
    expect(clientKey('2001:db8:aa:2::1')).not.toBe(key);
    expect(clientKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(clientKey('3fff::1')).toBe('3fff:0:0:0::/64');
  });

  it('keeps any other IPv6 address whole: a tailnet’s or a LAN’s devices share a /64', () => {
    expect(clientKey('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0:0:0:0:0:1');
    expect(clientKey('fd7a:115c:a1e0::2')).not.toBe(clientKey('fd7a:115c:a1e0::1'));
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0:0:0:0:0:0:1');
    expect(clientKey('::1')).toBe('0:0:0:0:0:0:0:1');
    expect(clientKey('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0:0:0:102:304');
    expect(clientKey('::ffff:7f00:1')).toBe('0:0:0:0:0:ffff:7f00:1');
  });

  it('reads an IPv4-mapped address as IPv4', () => {
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('a missing address is one key', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });
});
