import { BlockList, isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { LOOPBACK_RANGES, PRIVATE_RANGES, REFUSED_RANGES } from './safe-address.constants.js';
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

function blockList(entries: readonly (readonly [string, number, 'ipv4' | 'ipv6'])[]): BlockList {
  const list = new BlockList();
  for (const [network, prefix, family] of entries) list.addSubnet(network, prefix, family);
  return list;
}

const REFUSED = blockList(REFUSED_RANGES);
const LOOPBACK = blockList(LOOPBACK_RANGES);
const PRIVATE = blockList(PRIVATE_RANGES);

/**
 * An IPv4 address written as IPv6 is checked as the IPv4 address: mapped (`::ffff:10.0.0.1`, also
 * in hex, `::ffff:a00:1`) and the old compatible form (`::10.0.0.1`). `::` and `::1` stay IPv6.
 * Parsing is `ipaddr.js`'s (zone ids, `::`, dotted tails), the rule ours.
 */
function unwrap(address: string): { address: string; type: 'ipv4' | 'ipv6' } {
  if (isIP(address) === 4) return { address, type: 'ipv4' };
  if (!ipaddr.IPv6.isValid(address)) return { address, type: 'ipv6' };
  const ip = ipaddr.IPv6.parse(address);
  const [, , , , , sixth, high, low] = ip.parts;
  const zeros = ip.parts.slice(0, 5).every((part) => part === 0);
  if (ip.isIPv4MappedAddress() || (zeros && sixth === 0 && (high !== 0 || low > 1))) {
    const ipv4 = ipaddr.fromByteArray(ip.toByteArray().slice(12)).toString();
    return { address: ipv4, type: 'ipv4' };
  }
  return { address, type: 'ipv6' };
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
