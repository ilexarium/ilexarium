import { checkTarget, classify, type Lookup } from './safe-address.js';

const resolvesTo =
  (...addresses: string[]): Lookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('classify', () => {
  it.each([
    ['169.254.169.254', 'refused'],
    ['fe80::1', 'refused'],
    ['0.0.0.0', 'refused'],
    ['::', 'refused'],
    ['224.0.0.1', 'refused'],
    ['255.255.255.255', 'refused'],
    ['::ffff:169.254.169.254', 'refused'],
    ['::ffff:a9fe:a9fe', 'refused'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'refused'],
    ['::a9fe:a9fe', 'refused'],
    ['::169.254.169.254', 'refused'],
    ['::ffff:0:a9fe:a9fe', 'refused'],
    ['64:ff9b::a9fe:a9fe', 'refused'],
    ['64:ff9b:1::a9fe:a9fe', 'refused'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:c0a8:10a', 'private'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.20.0.5', 'private'],
    ['192.168.1.10', 'private'],
    ['100.101.102.103', 'private'],
    ['fd7a:115c:a1e0::1', 'private'],
    ['8.8.8.8', 'public'],
    ['2606:4700::1111', 'public'],
    ['172.32.0.1', 'public'],
    // Written other ways: upper case, a zone id, every zero spelled out, a tiny compatible form.
    ['::FFFF:A9FE:A9FE', 'refused'],
    ['fe80::1%eth0', 'refused'],
    ['0000:0000:0000:0000:0000:ffff:7f00:0001', 'loopback'],
    ['::2', 'refused'],
  ])('%s is %s', (address, expected) => {
    expect(classify(address)).toBe(expected);
  });
});

describe('checkTarget', () => {
  const check = (host: string, plain: boolean, lookup?: Lookup) =>
    checkTarget(host, { plain, lookup });

  it('refuses link-local addresses in a URL’s IPv6 form (the URL parser writes it in hex)', async () => {
    const host = new URL('http://[::ffff:169.254.169.254]/t').hostname;
    expect(host).toBe('[::ffff:a9fe:a9fe]');
    await expect(check(host, true)).rejects.toMatchObject({ problem: 'addressRefused' });
  });

  it('refuses link-local addresses (cloud metadata), typed or resolved', async () => {
    await expect(check('169.254.169.254', true)).rejects.toMatchObject({
      problem: 'addressRefused',
    });
    await expect(check('[fe80::1]', false)).rejects.toMatchObject({
      problem: 'addressRefused',
    });
    await expect(
      check('metadata.example.com', false, resolvesTo('169.254.169.254')),
    ).rejects.toMatchObject({ problem: 'addressRefused' });
  });

  it('refuses a name when any of its addresses is refused', async () => {
    await expect(
      check('ntfy.example.com', false, resolvesTo('8.8.8.8', 'fe80::1')),
    ).rejects.toMatchObject({ problem: 'addressRefused' });
  });

  it('allows loopback, LAN and VPN addresses, plain or not', async () => {
    expect(await check('127.0.0.1', true)).toMatchObject({
      address: '127.0.0.1',
      local: true,
      loopback: true,
    });
    expect(await check('ntfy.lan', true, resolvesTo('192.168.1.20'))).toMatchObject({
      address: '192.168.1.20',
      local: true,
      loopback: false,
    });
    expect(await check('box.vpn.lan', true, resolvesTo('100.64.1.2'))).toMatchObject({
      local: true,
    });
  });

  it('allows the internet only encrypted', async () => {
    expect(await check('ntfy.sh', false, resolvesTo('159.203.148.75'))).toMatchObject({
      address: '159.203.148.75',
      local: false,
    });
    await expect(check('ntfy.sh', true, resolvesTo('159.203.148.75'))).rejects.toMatchObject({
      problem: 'addressRefused',
    });
  });

  it('connects to the address checked', async () => {
    expect((await check('ntfy.sh', false, resolvesTo('2606:4700::1111'))).family).toBe(6);
  });

  it('a name that doesn’t resolve: notFound', async () => {
    const failing: Lookup = async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    };
    await expect(check('nowhere.invalid', false, failing)).rejects.toMatchObject({
      problem: 'notFound',
    });
    await expect(check('empty.example', false, resolvesTo())).rejects.toMatchObject({
      problem: 'notFound',
    });
  });
});
