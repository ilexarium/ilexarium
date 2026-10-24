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
    const dot = el.querySelector('[aria-hidden="true"]')!.className;
    expect(dot).toContain('motion-safe:animate-heartbeat');
    expect(dot).toContain('motion-reduce:animate-heartbeat-fade');
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

  it('beats and shows the kernel only while live', async () => {
    const status = signal<Status>('reconnecting');
    TestBed.configureTestingModule({
      providers: [
        { provide: RealtimeService, useValue: { status } },
        {
          provide: MonitoringStore,
          useValue: {
            host: signal<HostInfo>({
              hostname: 'box',
              os: 'Debian GNU/Linux 13',
              kernel: '6.12.48-1-amd64',
              arch: 'x64',
              cpuModel: null,
              cpuCores: 4,
            }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ConnectionStatus);
    const el = fixture.nativeElement as HTMLElement;
    const dot = () => el.querySelector('[aria-hidden="true"]')!.className;
    const label = () => el.querySelector<HTMLElement>('span:not([aria-hidden])')!;
    for (const value of ['connecting', 'reconnecting', 'offline'] as Status[]) {
      status.set(value);
      await fixture.whenStable();
      expect(dot(), value).not.toContain('heartbeat');
      expect(label().getAttribute('tabindex'), value).toBeNull();
    }
    status.set('live');
    await fixture.whenStable();
    expect(dot()).toContain('heartbeat');
    expect(label().getAttribute('tabindex')).toBe('0');
  });
});
