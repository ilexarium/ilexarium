import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StatusBadge } from './status-badge';
import type { StatusTone } from './status-badge.model';

@Component({
  imports: [StatusBadge],
  template: `<app-status-badge [tone]="tone()">Label</app-status-badge>`,
})
class Host {
  readonly tone = signal<StatusTone>('healthy');
}

describe('StatusBadge', () => {
  async function render(tone: StatusTone) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.tone.set(tone);
    await fixture.whenStable();
    return fixture.nativeElement.querySelector('app-status-badge') as HTMLElement;
  }

  it.each([
    ['healthy', 'text-success'],
    ['warning', 'text-warning'],
    ['failed', 'text-destructive'],
    ['info', 'text-info'],
  ] as const)(
    '%s: its colours and an icon beside the text (never colour alone)',
    async (tone, color) => {
      const badge = await render(tone);
      expect(badge.className).toContain(color);
      expect(badge.querySelector('ng-icon')).toBeTruthy();
      expect(badge.textContent?.trim()).toBe('Label');
    },
  );

  it('neutral: an outline, no icon', async () => {
    const badge = await render('neutral');
    expect(badge.className).toContain('border-border');
    expect(badge.className).not.toContain('border-transparent');
    expect(badge.querySelector('ng-icon')).toBeNull();
  });
});
