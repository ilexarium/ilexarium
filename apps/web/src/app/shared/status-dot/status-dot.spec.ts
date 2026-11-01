import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StatusDot } from './status-dot';
import type { DotTone } from './status-dot.model';

@Component({
  imports: [StatusDot],
  template: `<laris-status-dot [tone]="tone()">Running</laris-status-dot>`,
})
class Host {
  readonly tone = signal<DotTone>('live');
}

describe('StatusDot', () => {
  it('pulses while something runs, stays still otherwise; the word is the text', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const dot = () => el.querySelector('[aria-hidden="true"]')!.className;
    expect(el.textContent!.trim()).toBe('Running');
    expect(dot()).toContain('motion-safe:animate-light-pulse');
    fixture.componentInstance.tone.set('fail');
    await fixture.whenStable();
    expect(dot()).toContain('text-light-fail');
    expect(dot()).not.toContain('animate-light-pulse');
  });
});
