import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BackupPlan } from '@laris/shared';
import { BackupsPageStore } from '../backups-page/backups-page-store';
import { BackupSettings } from './backup-settings';

const plan = (updatedAt: string, daily = 7): BackupPlan => ({
  destination: '/mnt/backup',
  schedule: { frequency: 'daily', time: '03:00' },
  retention: { daily, weekly: 4, monthly: 6 },
  destinationStatus: null,
  items: [],
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt,
});

@Component({
  imports: [BackupSettings],
  template: `<laris-backup-settings [plan]="plan()" />`,
})
class Host {
  readonly plan = signal(plan('2026-10-20T00:00:00.000Z'));
}

const daily = () => document.querySelector<HTMLInputElement>('#settings-keep-daily')!;

async function render() {
  TestBed.configureTestingModule({
    providers: [{ provide: BackupsPageStore, useValue: { updatePlan: vi.fn() } }],
  });
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return fixture;
}

async function type(fixture: { whenStable(): Promise<unknown> }, value: string) {
  daily().value = value;
  daily().dispatchEvent(new Event('input'));
  await fixture.whenStable();
}

describe('BackupSettings', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps what is being typed when the page reloads the same plan', async () => {
    const fixture = await render();
    expect(daily().value).toBe('7');
    await type(fixture, '9');
    fixture.componentInstance.plan.set(plan('2026-10-20T00:00:00.000Z'));
    await fixture.whenStable();
    expect(daily().value).toBe('9');
  });

  it('shows the plan as saved once it changes', async () => {
    const fixture = await render();
    await type(fixture, '9');
    fixture.componentInstance.plan.set(plan('2026-10-21T00:00:00.000Z', 14));
    await fixture.whenStable();
    expect(daily().value).toBe('14');
  });
});
