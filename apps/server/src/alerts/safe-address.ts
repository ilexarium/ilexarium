import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { DeliveryError } from './alerts.model.js';

/** Resolves a name to all of its addresses (Node's `dns.promises.lookup` with `all: true`). */
export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

/** Where a message may go: the address checked, to connect to instead of resolving again. */
export interface SafeTarget {
  address: string;
  family: 4 | 6;
  /** Loopback or a private network (LAN, Tailscale): plain HTTP is allowed there. */
  local: boolean;
  loopback: boolean;
}

export const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

function blockList(entries: [string, number, 'ipv4' | 'ipv6'][]): BlockList {
  const list = new BlockList();
  for (const [network, prefix, family] of entries) list.addSubnet(network, prefix, family);
  return list;
}

/** Never: cloud metadata and other link-local services, multicast, broadcast, "this host". */
const REFUSED = blockList([
  ['0.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]);
const LOOPBACK = blockList([
  ['127.0.0.0', 8, 'ipv4'],
  ['::1', 128, 'ipv6'],
]);
/** LAN ranges, Tailscale's (100.64.0.0/10, fd7a:115c:a1e0::/48 inside fc00::/7). */
const PRIVATE = blockList([
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
]);

/** An IPv4 address written as IPv6 (`::ffff:10.0.0.1`) is checked as the IPv4 address. */
function unwrap(address: string): { address: string; type: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1], type: 'ipv4' };
  return { address, type: isIP(address) === 4 ? 'ipv4' : 'ipv6' };
}

export function classify(address: string): 'refused' | 'loopback' | 'private' | 'public' {
  const ip = unwrap(address);
  if (REFUSED.check(ip.address, ip.type)) return 'refused';
  if (LOOPBACK.check(ip.address, ip.type)) return 'loopback';
  if (PRIVATE.check(ip.address, ip.type)) return 'private';
  return 'public';
}

/**
 * The address rule (docs/plans/health_alerts.md, "Where the app may send"): the app sends to an
 * address the user typed, so never to the platform's own ports (`reservedPorts`) on any address,
 * nor to link-local addresses (cloud metadata) — loopback, LAN, Tailscale and the internet are
 * fine. Checked **after the name is resolved**: every address the name has must pass (one
 * pointing somewhere refused is refused), and the caller connects to the address returned.
 * `plain`: an unencrypted connection, allowed only to loopback and private addresses.
 */
export async function checkTarget(
  host: string,
  port: number,
  options: { reservedPorts: readonly number[]; plain: boolean; lookup?: Lookup },
): Promise<SafeTarget> {
  if (options.reservedPorts.includes(port)) {
    throw new DeliveryError('addressRefused', `Port ${port} is one of the platform's own`);
  }
  const bare = host.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  let addresses: { address: string; family: number }[];
  if (isIP(bare)) addresses = [{ address: bare, family: isIP(bare) }];
  else {
    try {
      addresses = await (options.lookup ?? systemLookup)(bare);
    } catch {
      throw new DeliveryError('notFound', `${host} doesn't resolve`);
    }
  }
  if (addresses.length === 0) throw new DeliveryError('notFound', `${host} doesn't resolve`);
  const classes = addresses.map((a) => classify(a.address));
  if (classes.includes('refused')) {
    throw new DeliveryError(
      'addressRefused',
      `${host} points to an address the app never sends to`,
    );
  }
  const local = classes.every((c) => c !== 'public');
  if (options.plain && !local) {
    throw new DeliveryError(
      'addressRefused',
      'Plain HTTP only to this machine or the local network',
    );
  }
  const first = addresses[0];
  return {
    address: first.address,
    family: first.family === 6 ? 6 : 4,
    local,
    loopback: classes.every((c) => c === 'loopback'),
  };
}
