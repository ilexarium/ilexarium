import {
  isKernelThread,
  parseBootTime,
  parseCmdline,
  parseContainerId,
  parseCpuCount,
  parsePasswd,
  parsePressure,
  parseProcStat,
  parseProcStatus,
  procHidesProcesses,
} from './process-parsers.js';

const ID = 'a'.repeat(64);

/** A /proc/<pid>/stat line: fields 3… after the name. */
const stat = (
  pid: number,
  name: string,
  { flags = 4194560, utime = 120, stime = 30, start = 98765 } = {},
) =>
  `${pid} (${name}) S 1 ${pid} ${pid} 0 -1 ${flags} 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${start} 10000 300 18446744073709551615\n`;

describe('process parsers', () => {
  it('reads /proc/<pid>/stat: state, flags, CPU ticks, priority, nice, start time, virtual size', () => {
    expect(parseProcStat(stat(4312, 'python3'))).toEqual({
      pid: 4312,
      name: 'python3',
      state: 'S',
      flags: 4194560,
      cpuTicks: 150,
      priority: 20,
      nice: 0,
      startTicks: '98765',
      virtualBytes: 10000,
    });
    const niced = stat(4312, 'python3').replace(' 20 0 1 0 ', ' 39 19 1 0 ');
    expect(parseProcStat(niced)).toMatchObject({ priority: 39, nice: 19 });
    const realtime = stat(4312, 'python3').replace(' 20 0 1 0 ', ' -51 -20 1 0 ');
    expect(parseProcStat(realtime)).toMatchObject({ priority: -51, nice: -20 });
  });

  it('reads a name with spaces and parentheses (counted from the last parenthesis)', () => {
    const parsed = parseProcStat(stat(77, 'my (odd) app) x'));
    expect(parsed).toMatchObject({ name: 'my (odd) app) x', cpuTicks: 150, startTicks: '98765' });
  });

  it('refuses something that isn’t a stat line (a process gone while read)', () => {
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('4312 python3 S 1')).toBeNull();
    expect(parseProcStat('4312 (python3) S 1 2 3')).toBeNull();
  });

  it('tells kernel threads by their flags', () => {
    expect(isKernelThread(parseProcStat(stat(2, 'kthreadd', { flags: 0x208040 }))!)).toBe(true);
    expect(isKernelThread(parseProcStat(stat(4312, 'python3'))!)).toBe(false);
  });

  it('reads the four uids, resident and shared memory from /proc/<pid>/status', () => {
    const status =
      'Name:\tpython3\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nVmRSS:\t  20480 kB\nRssAnon:\t  16384 kB\nRssFile:\t   3072 kB\nRssShmem:\t   1024 kB\n';
    expect(parseProcStatus(status)).toEqual({
      uids: [1000, 1000, 1000, 1000],
      rssBytes: 20480 * 1024,
      sharedBytes: 4096 * 1024,
    });
    expect(parseProcStatus('Name:\tkthreadd\nUid:\t0\t0\t0\t0\n')).toEqual({
      uids: [0, 0, 0, 0],
      rssBytes: 0,
      sharedBytes: 0,
    });
    expect(parseProcStatus('Name:\tx\n')).toBeNull();
  });

  it('turns the NUL-separated command line into one', () => {
    expect(parseCmdline('python3\0train.py\0--epochs=5\0')).toBe('python3 train.py --epochs=5');
    expect(parseCmdline('')).toBe('');
  });

  it.each([
    ['Docker, cgroup v2', `0::/system.slice/docker-${ID}.scope`, ID],
    ['Docker, cgroup v1', `12:pids:/docker/${ID}\n11:memory:/docker/${ID}`, ID],
    ['Podman', `0::/machine.slice/libpod-${ID}.scope/container`, ID],
    ['containerd (Kubernetes)', `0::/kubepods/besteffort/pod1/cri-containerd-${ID}.scope`, ID],
    ['a container without its ID', '0::/kubepods/burstable/pod1/abc', ''],
    ['a systemd-nspawn machine', '0::/machine.slice/machine-web.scope/payload', ''],
    [
      'a rootless Docker container',
      `0::/user.slice/user-1000.slice/user@1000.service/app.slice/docker-${ID}.scope`,
      ID,
    ],
    ['Podman without systemd', `0::/libpod_parent/libpod-${ID}`, ID],
    ['containerd without systemd', `0::/containerd/${ID}`, ID],
    ['a Docker subtree without an ID', '0::/docker/buildkit/xyz', ''],
    ['a containerd scope without a full ID', '0::/system.slice/cri-containerd-abc.scope', ''],
    ['the Docker daemon itself', '0::/system.slice/docker.service', null],
    ['containerd itself', '0::/system.slice/containerd.service', null],
    [
      'a person’s rootless Docker daemon',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/docker.service',
      null,
    ],
    ['a person’s session', '0::/user.slice/user-1000.slice/session-2.scope', null],
    ['a system service', '0::/system.slice/sshd.service', null],
  ])('finds the container in its cgroup: %s', (_, cgroup, expected) => {
    expect(parseContainerId(cgroup)).toBe(expected);
  });

  it('reads account names from /etc/passwd (the first entry for a uid wins)', () => {
    const passwd =
      'root:x:0:0:root:/root:/bin/bash\nanna:x:1000:1000::/home/anna:/bin/bash\nalias:x:1000:1000::/:/bin/sh\n#comment\nbroken\n';
    expect(parsePasswd(passwd)).toEqual(
      new Map([
        [0, 'root'],
        [1000, 'anna'],
      ]),
    );
  });

  it('reads the boot time from /proc/stat', () => {
    expect(parseBootTime('cpu  1 2 3\nbtime 1760700000\nprocesses 5\n')).toBe(1760700000);
    expect(parseBootTime('cpu  1 2 3\n')).toBeNull();
  });

  it('counts the cores from /proc/stat', () => {
    expect(parseCpuCount('cpu  1 2 3\ncpu0 1 2 3\ncpu1 1 2 3\nintr 5\n')).toBe(2);
    expect(parseCpuCount('cpu  1 2 3\n')).toBe(1);
  });

  it('reads the last minute’s pressure (`some avg60`)', () => {
    const io =
      'some avg10=1.50 avg60=12.25 avg300=3.00 total=123\nfull avg10=0.00 avg60=2.00 avg300=0.00 total=9\n';
    expect(parsePressure(io)).toBe(12.25);
    expect(parsePressure('full avg10=0.00 avg60=2.00 avg300=0.00 total=9\n')).toBeNull();
    expect(parsePressure('')).toBeNull();
  });

  it('tells when /proc hides other users’ processes', () => {
    const mounts = (options: string) => `sysfs /sys sysfs rw 0 0\nproc /proc proc ${options} 0 0\n`;
    expect(procHidesProcesses(mounts('rw,nosuid,nodev,noexec,relatime'))).toBe(false);
    expect(procHidesProcesses(mounts('rw,relatime,hidepid=2'))).toBe(true);
    expect(procHidesProcesses(mounts('rw,relatime,hidepid=invisible'))).toBe(true);
    expect(procHidesProcesses(mounts('rw,relatime,hidepid=0'))).toBe(false);
  });
});
