import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LinuxStatus } from './linux-status';

@Component({
  imports: [LinuxStatus],
  template: `<laris-linux-status
    username="anna"
    [sudoMinutes]="minutes()"
    (lock)="locked = locked + 1"
    (close)="closed = closed + 1"
  />`,
})
class Host {
  readonly minutes = signal<number | null>(null);
  locked = 0;
  closed = 0;
}

describe('LinuxStatus', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  async function render(minutes: number | null) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.minutes.set(minutes);
    await fixture.whenStable();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    const openMenu = async () => {
      button.click();
      await fixture.whenStable();
      return document.querySelector<HTMLElement>('[data-slot="dropdown-menu"]')!;
    };
    const item = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) =>
        i.textContent!.includes(text),
      );
    return { fixture, button, openMenu, item };
  }

  it('names the account; locked, its menu closes the Linux session', async () => {
    const { fixture, button, openMenu, item } = await render(null);
    expect(button.getAttribute('aria-label')).toBe('Linux session: anna');
    expect(button.textContent).toContain('anna');
    expect(button.textContent).not.toContain('admin');
    const menu = await openMenu();
    expect(menu.textContent).toContain('Administrator rights are locked');
    expect(item('Lock now')).toBeUndefined();
    item('Close Linux session')!.click();
    expect(fixture.componentInstance.closed).toBe(1);
  });

  it('while sudo is unlocked: the minutes left, and “Lock now”', async () => {
    const { fixture, button, openMenu, item } = await render(4);
    expect(button.getAttribute('aria-label')).toBe(
      'Linux session: anna, administrator for 4 more minutes',
    );
    expect(button.textContent).toContain('admin · 4 min');
    const menu = await openMenu();
    expect(menu.textContent).toContain('Administrator rights (sudo) for about 4 more minutes');
    item('Lock now')!.click();
    expect(fixture.componentInstance.locked).toBe(1);
  });

  it('one minute left: singular', async () => {
    const { button } = await render(1);
    expect(button.getAttribute('aria-label')).toBe(
      'Linux session: anna, administrator for 1 more minute',
    );
  });
});
