import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RemoveDialog } from './remove-dialog';

@Component({
  imports: [RemoveDialog],
  template: `<ilex-remove-dialog name="music" (remove)="removed.set(removed() + 1)" />`,
})
class Host {
  readonly dialog = viewChild.required(RemoveDialog);
  readonly removed = signal(0);
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )!;

async function open() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  fixture.componentInstance.dialog().open();
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  await fixture.whenStable();
  return fixture;
}

describe('RemoveDialog', () => {
  afterEach(() => document.querySelectorAll('[role="alertdialog"]').forEach((d) => d.remove()));

  it('says its files stay and nothing is ticked to delete; Remove confirms', async () => {
    const fixture = await open();
    expect(dialog()!.textContent).toContain('Remove music');
    expect(dialog()!.textContent).toContain('Its files and data stay');
    expect(dialog()!.textContent).toContain('Its backups stay.');
    expect(dialog()!.querySelector('input')).toBeNull();
    button('Remove').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.removed()).toBe(1);
  });

  it('Cancel removes nothing', async () => {
    const fixture = await open();
    button('Cancel').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.removed()).toBe(0);
  });
});
