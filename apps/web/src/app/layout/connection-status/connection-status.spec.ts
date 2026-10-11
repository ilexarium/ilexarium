import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RealtimeService } from '../../core/realtime/realtime-service';
import { ConnectionStatus } from './connection-status';
import type { ConnectionStatus as Status } from '../../core/realtime/realtime.model';

describe('ConnectionStatus', () => {
  it('says whether live data is flowing, as a status for screen readers', async () => {
    const status = signal<Status>('connecting');
    TestBed.configureTestingModule({
      providers: [{ provide: RealtimeService, useValue: { status } }],
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
});
