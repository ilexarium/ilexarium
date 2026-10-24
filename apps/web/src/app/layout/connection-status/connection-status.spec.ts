import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { HostInfo } from '@laris/shared';
import { MonitoringStore } from '../../core/monitoring/monitoring-store';
import { RealtimeService } from '../../core/realtime/realtime-service';
import { ConnectionStatus } from './connection-status';
import type { ConnectionStatus as Status } from '../../core/realtime/realtime.model';

describe('ConnectionStatus', () => {
  it('says whether live data is flowing, as a status for screen readers', async () => {
    const status = signal<Status>('connecting');
    TestBed.configureTestingModule({
      providers: [
        { provide: RealtimeService, useValue: { status } },
        { provide: MonitoringStore, useValue: { host: signal(null) } },
      ],
    });
    const fixture = TestBed.createComponent(ConnectionStatus);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    expect(el.getAttribute('role')).toBe('status');

    const labels: Record<Status, string> = {
      connecting: 'Connecting…',
      live: 'Live',
      reconnecting: 'Reconnecting…',
      offline: 'Offline',
    };
    for (const [value, label] of Object.entries(labels) as [Status, string][]) {
      status.set(value);
      await fixture.whenStable();
      expect(el.textContent?.trim(), value).toBe(label);
      expect(el.getAttribute('data-status')).toBe(value);
    }
  });

  it('beats while live, and shows the kernel (hover or keyboard focus) once the machine is known', async () => {
    const host = signal<HostInfo | null>(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: RealtimeService, useValue: { status: signal<Status>('live') } },
        { provide: MonitoringStore, useValue: { host } },
      ],
    });
    const fixture = TestBed.createComponent(ConnectionStatus);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await fixture.whenStable();
    expect(el.querySelector('[aria-hidden="true"]')!.className).toContain('animate-heartbeat');
    const label = el.querySelector<HTMLElement>('span:not([aria-hidden])')!;
    expect(label.getAttribute('tabindex')).toBeNull();

    host.set({
      hostname: 'box',
      os: 'Debian GNU/Linux 13',
      kernel: '6.12.48-1-amd64',
      arch: 'x64',
      cpuModel: null,
      cpuCores: 4,
    });
    await fixture.whenStable();
    expect(label.getAttribute('tabindex')).toBe('0');
    label.focus();
    await vi.waitFor(() => expect(document.body.textContent).toContain('6.12.48-1-amd64'));
    el.remove();
  });
});
