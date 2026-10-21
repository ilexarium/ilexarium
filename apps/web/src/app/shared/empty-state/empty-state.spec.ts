import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EmptyState } from './empty-state';

@Component({
  imports: [EmptyState],
  template: `<laris-empty-state icon="lucideBox" text="No containers yet." detail="More">
    <a href="/services">Install a service</a>
  </laris-empty-state>`,
})
class Host {}

describe('EmptyState', () => {
  it('shows the icon, the sentence, the detail and the next action', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('ng-icon')).toBeTruthy();
    expect(el.textContent).toContain('No containers yet.');
    expect(el.textContent).toContain('More');
    expect(el.querySelector('a')?.textContent).toBe('Install a service');
  });
});
