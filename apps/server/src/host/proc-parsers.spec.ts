import {
  bytesPerSecond,
  cpuUsagePercent,
  isShownInterface,
  parseCpuTimes,
  parseListeningTcpPorts,
  parseMeminfo,
  parseNetDev,
  parseOsRelease,
} from './proc-parsers.js';

describe('parseCpuTimes', () => {
  const stat = [
    'cpu  103792 1391 36251 8059069 2684 114392 4108 7 50 0',
    'cpu0 12203 94 4614 1003108 236 17489 1980 0 0 0',
    'intr 123 0 0',
  ].join('\n');

  it('reads the aggregate line, idle including iowait, guest time not counted twice', () => {
    expect(parseCpuTimes(stat)).toEqual({
      idle: 8059069 + 2684,
      total: 103792 + 1391 + 36251 + 8059069 + 2684 + 114392 + 4108 + 7,
    });
  });

  it('accepts old kernels with only the first four fields', () => {
    expect(parseCpuTimes('cpu  10 0 10 80\n')).toEqual({ idle: 80, total: 100 });
  });

  it('fails without an aggregate line', () => {
    expect(() => parseCpuTimes('cpu0 1 2 3 4\n')).toThrow(/no aggregate cpu line/);
  });
});

describe('cpuUsagePercent', () => {
  it('is the busy share of the elapsed time', () => {
    expect(cpuUsagePercent({ idle: 100, total: 200 }, { idle: 175, total: 300 })).toBe(25);
  });

  it('is 0 when no time passed and stays within 0–100', () => {
    expect(cpuUsagePercent({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBe(0);
    expect(cpuUsagePercent({ idle: 50, total: 100 }, { idle: 40, total: 110 })).toBe(100);
    expect(cpuUsagePercent({ idle: 10, total: 100 }, { idle: 30, total: 110 })).toBe(0);
  });
});

describe('parseMeminfo', () => {
  const meminfo = [
    'MemTotal:       12217288 kB',
    'MemFree:         2660996 kB',
    'MemAvailable:    9882324 kB',
    'Buffers:          216148 kB',
    'Cached:          7197268 kB',
    'SwapTotal:       2097148 kB',
    'SwapFree:        2000000 kB',
    'Active(anon):     123456 kB',
    'HugePages_Total:       0',
  ].join('\n');

  it('reads the fields in bytes', () => {
    expect(parseMeminfo(meminfo)).toEqual({
      totalBytes: 12217288 * 1024,
      availableBytes: 9882324 * 1024,
      swapTotalBytes: 2097148 * 1024,
      swapFreeBytes: 2000000 * 1024,
    });
  });

  it('approximates available memory on kernels without MemAvailable', () => {
    const old = meminfo.replace(/^MemAvailable.*\n/m, '');
    expect(parseMeminfo(old).availableBytes).toBe((2660996 + 216148 + 7197268) * 1024);
  });

  it('reports no swap as zero', () => {
    const noSwap = meminfo.replace(/^Swap.*\n/gm, '');
    expect(parseMeminfo(noSwap)).toMatchObject({ swapTotalBytes: 0, swapFreeBytes: 0 });
  });

  it('fails without MemTotal', () => {
    expect(() => parseMeminfo('MemFree: 1 kB\n')).toThrow(/MemTotal/);
  });
});

describe('parseNetDev', () => {
  const netDev = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 20666922   35330    0    0    0     0          0         0 20666922   35330    0    0    0     0       0          0',
    'enp0s1:1599684265 1247153    0    0    0     0          0         0 79297326  309623    0    0    0     0       0          0',
    'tailscale0:      86       1    0    0    0     0          0         0     5285      47    0    0    0     0       0          0',
    '',
  ].join('\n');

  it('reads received and transmitted bytes per interface, with or without a space after the colon', () => {
    expect(parseNetDev(netDev)).toEqual(
      new Map([
        ['lo', { rxBytes: 20666922, txBytes: 20666922 }],
        ['enp0s1', { rxBytes: 1599684265, txBytes: 79297326 }],
        ['tailscale0', { rxBytes: 86, txBytes: 5285 }],
      ]),
    );
  });
});

describe('isShownInterface', () => {
  it('shows physical interfaces and VPNs', () => {
    for (const name of ['eth0', 'enp0s1', 'wlan0', 'tailscale0', 'wg0', 'bond0']) {
      expect(isShownInterface(name), name).toBe(true);
    }
  });

  it('hides loopback and Docker’s virtual interfaces', () => {
    for (const name of ['lo', 'docker0', 'br-1a2b3c4d5e6f', 'veth12ab34c']) {
      expect(isShownInterface(name), name).toBe(false);
    }
  });

  it('matches whole names only', () => {
    expect(isShownInterface('lo1')).toBe(true);
    expect(isShownInterface('docker01')).toBe(true);
  });
});

describe('bytesPerSecond', () => {
  it('divides the counter difference by the elapsed time', () => {
    expect(bytesPerSecond(1000, 5000, 2)).toBe(2000);
  });

  it('is 0 after a counter reset or without elapsed time', () => {
    expect(bytesPerSecond(5000, 100, 2)).toBe(0);
    expect(bytesPerSecond(1000, 5000, 0)).toBe(0);
  });
});

describe('parseOsRelease', () => {
  it('prefers PRETTY_NAME and strips quotes', () => {
    const text = 'NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\n';
    expect(parseOsRelease(text)).toBe('Debian GNU/Linux 13 (trixie)');
  });

  it('falls back to NAME, and accepts single quotes and no quotes', () => {
    expect(parseOsRelease("NAME='Alpine Linux'\n")).toBe('Alpine Linux');
    expect(parseOsRelease('NAME=Arch\n')).toBe('Arch');
  });

  it('is null when neither is there', () => {
    expect(parseOsRelease('ID=custom\n')).toBeNull();
  });
});

describe('parseListeningTcpPorts', () => {
  it('finds the listening ports (state 0A), IPv4 and IPv6, and nothing else', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 1',
      '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2',
      '   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 3',
    ].join('\n');
    expect(parseListeningTcpPorts(tcp)).toEqual(new Set([3000, 22]));
    const tcp6 = [
      '  sl  local_address                         remote_address                        st',
      '   0: 00000000000000000000000000000000:11C1 00000000000000000000000000000000:0000 0A',
    ].join('\n');
    expect(parseListeningTcpPorts(tcp6)).toEqual(new Set([4545]));
    expect(parseListeningTcpPorts('')).toEqual(new Set());
  });
});
