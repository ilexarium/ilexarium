import { TestBed } from '@angular/core/testing';
import type { HostInfo } from '@laris/shared';
import { HostSummary } from './host-summary';

const host: HostInfo = {
  hostname: 'laris',
  os: 'Debian GNU/Linux 13',
  kernel: '6.12.0',
  arch: 'arm64',
  cpuModel: 'Cortex-A76',
  cpuCores: 4,
};

async function text(info: HostInfo) {
  const fixture = TestBed.createComponent(HostSummary);
  fixture.componentRef.setInput('host', info);
  fixture.componentRef.setInput('uptimeSeconds', 3_700);
  await fixture.whenStable();
  return (fixture.nativeElement as HTMLElement).textContent!.replace(/\s+/g, ' ').trim();
}

describe('HostSummary', () => {
  it('names the machine, OS, kernel, CPU and uptime', async () => {
    expect(await text(host)).toBe(
      'laris · Debian GNU/Linux 13 · Linux 6.12.0 · Cortex-A76 (arm64) · up 1 hour, 1 minute',
    );
  });

  it('shows the architecture alone when the CPU model is unknown', async () => {
    expect(await text({ ...host, cpuModel: null })).toContain('· arm64 ·');
  });
});
