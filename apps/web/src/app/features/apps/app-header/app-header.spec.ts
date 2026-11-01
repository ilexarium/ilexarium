import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppState } from '@laris/shared';
import { AppHeader } from './app-header';

@Component({
  imports: [AppHeader],
  template: `<laris-app-header
    name="music"
    templateName="Navidrome"
    owner="anna"
    folder="/home/anna/apps/music"
    [containers]="2"
    [state]="state()"
    [installing]="installing()"
    [actions]="actions()"
    [busy]="busy()"
    (start)="events.push('start')"
    (stop)="events.push('stop')"
    (remove)="events.push('remove')"
  />`,
})
class Host {
  readonly state = signal<AppState | null>('running');
  readonly installing = signal(false);
  readonly actions = signal(true);
  readonly busy = signal(false);
  readonly events: string[] = [];
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const buttons = () => [...el.querySelectorAll('button')].map((b) => b.textContent!.trim());
  const set = async (change: (host: Host) => void) => {
    change(fixture.componentInstance);
    await fixture.whenStable();
  };
  return { el, host: fixture.componentInstance, buttons, set };
}

const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

describe('AppHeader', () => {
  it('says what (its template, not the template’s version — not the app’s), how it’s doing, whose, where (the home as ~) and how many containers', async () => {
    const { el } = await render();
    expect(el.querySelector('h2')!.textContent).toContain('music');
    expect(el.textContent).toContain('Navidrome');
    expect(el.textContent).toContain('Running');
    expect(el.textContent).toContain("anna's");
    expect(el.textContent).toContain('~/apps/music');
    expect(el.textContent).toContain('2 containers');
  });

  it('offers Stop while it runs, Start once stopped, and both while partly running', async () => {
    const { buttons, set, host, el } = await render();
    expect(buttons()).toContain('Stop');
    expect(buttons()).not.toContain('Start');
    await set((h) => h.state.set('stopped'));
    expect(buttons()).toContain('Start');
    expect(buttons()).not.toContain('Stop');
    await set((h) => h.state.set('partial'));
    expect(buttons()).toEqual(expect.arrayContaining(['Start', 'Stop']));
    [...el.querySelectorAll('button')].find((b) => b.textContent!.includes('Start'))!.click();
    expect(host.events).toEqual(['start']);
  });

  it('has Remove in its "⋯" menu, not while something runs', async () => {
    const { el, host, set } = await render();
    const more = el.querySelector<HTMLButtonElement>('button[aria-label="More for music"]')!;
    more.click();
    await vi.waitFor(() => expect(menuItems()).toHaveLength(1));
    expect(menuItems()[0].textContent).toContain('Remove');
    expect(menuItems()[0].disabled).toBe(false);
    menuItems()[0].click();
    expect(host.events).toEqual(['remove']);
    await vi.waitFor(() => expect(menuItems()).toHaveLength(0));
    await set((h) => h.busy.set(true));
    more.click();
    await vi.waitFor(() => expect(menuItems()).toHaveLength(1));
    expect(menuItems()[0].disabled).toBe(true);
  });

  it('while installing: says so, no actions', async () => {
    const { el, buttons, set } = await render();
    await set((h) => {
      h.installing.set(true);
      h.actions.set(false);
    });
    expect(el.textContent).toContain('Installing…');
    expect(buttons()).toEqual([]);
  });
});
