import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SaveBar } from './save-bar';

@Component({
  imports: [SaveBar],
  template: `<laris-save-bar
    saveLabel="apps.save.action"
    [actions]="actions()"
    (discard)="discarded = discarded + 1"
    (save)="saved = saved + 1"
    ><p>Changed on disk</p></laris-save-bar
  >`,
})
class Host {
  readonly actions = signal(true);
  discarded = 0;
  saved = 0;
}

describe('SaveBar', () => {
  it('says there are changes and offers Discard and Save; content goes above or instead', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
    expect(el.textContent).toContain('Unsaved changes');
    expect(el.textContent).toContain('Changed on disk');
    button('Discard changes').click();
    button('Save and apply').click();
    expect(fixture.componentInstance.discarded).toBe(1);
    expect(fixture.componentInstance.saved).toBe(1);
    fixture.componentInstance.actions.set(false);
    await fixture.whenStable();
    expect(el.textContent).not.toContain('Unsaved changes');
    expect(el.textContent).toContain('Changed on disk');
  });
});
