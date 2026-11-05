/** A network: its first address, prefix length and family. */
type Range = readonly [string, number, 'ipv4' | 'ipv6'];

/** Never: cloud metadata and other link-local services, multicast, broadcast, "this host". */
export const REFUSED_RANGES: readonly Range[] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  // Translated to IPv4 by a gateway (NAT64, SIIT): the IPv4 address inside can't be checked here.
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['::ffff:0:0:0', 96, 'ipv6'],
];

export const LOOPBACK_RANGES: readonly Range[] = [
  ['127.0.0.0', 8, 'ipv4'],
  ['::1', 128, 'ipv6'],
];

/** LAN ranges, shared address space (100.64.0.0/10, used by VPNs) and unique local IPv6. */
export const PRIVATE_RANGES: readonly Range[] = [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
];
