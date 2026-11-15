import { isIP } from 'node:net';

/**
 * Whose request it is, for rate limits: an IPv4 address as it is, a public IPv6 address
 * (2000::/3) by its /64 (one client has a whole /64 to pick addresses from), any other IPv6
 * address whole (a tailnet's or a LAN's devices share one /64), an IPv4-mapped one as IPv4.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const address = ip.split('%')[0];
  if (isIP(address) !== 6) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  const all = groups(address);
  const isPublic = (parseInt(all[0], 16) & 0xe000) === 0x2000;
  return isPublic ? `${all.slice(0, 4).join(':')}::/64` : all.join(':');
}

/** The eight groups of a valid IPv6 address, written short (`2001:db8:0:0:…`). */
function groups(address: string): string[] {
  const split = (part: string) =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [group];
          const [a, b, c, d] = group.split('.').map(Number);
          return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
        });
  const [head, tail] = address.split('::');
  const start = split(head);
  const end = tail === undefined ? [] : split(tail);
  const zeros = Array<string>(8 - start.length - end.length).fill('0');
  return [...start, ...zeros, ...end].map((group) => parseInt(group, 16).toString(16));
}
