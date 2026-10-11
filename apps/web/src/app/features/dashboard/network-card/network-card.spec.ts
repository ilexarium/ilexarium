import { TestBed } from '@angular/core/testing';
import type { NetworkInterfaceStats } from '@homelab/shared';
import { NetworkCard } from './network-card';

async function render(interfaces: NetworkInterfaceStats[]) {
  const fixture = TestBed.createComponent(NetworkCard);
  fixture.componentRef.setInput('interfaces', interfaces);
  fixture.componentRef.setInput('history', []);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

/** What a screen reader gets: visible text plus sr-only text, without aria-hidden parts. */
function spoken(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
  return clone.textContent!.replace(/\s+/g, ' ').trim();
}

describe('NetworkCard', () => {
  it('totals all interfaces, with words for screen readers instead of arrows', async () => {
    const el = await render([
      { name: 'eth0', rxBytesPerSec: 1_000_000, txBytesPerSec: 200_000 },
      { name: 'tailscale0', rxBytesPerSec: 200_000, txBytesPerSec: 100_000 },
    ]);
    const totals = el.querySelector('p.text-2xl')!;
    expect(spoken(totals)).toBe('Receiving 1.2 MB/s Sending 300 kB/s');
    const rows = [...el.querySelectorAll('li')].map(spoken);
    expect(rows).toEqual([
      'eth0: receiving 1.0 MB/s, sending 200 kB/s',
      'tailscale0: receiving 200 kB/s, sending 100 kB/s',
    ]);
  });

  it('lists interfaces only when there is more than one', async () => {
    const el = await render([{ name: 'eth0', rxBytesPerSec: 0, txBytesPerSec: 0 }]);
    expect(el.querySelectorAll('li')).toHaveLength(0);
  });

  it('says so when there is no interface', async () => {
    expect((await render([])).textContent).toContain('No network interfaces found.');
  });
});
