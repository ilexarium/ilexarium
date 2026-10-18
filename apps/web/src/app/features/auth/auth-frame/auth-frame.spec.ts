import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthFrame } from './auth-frame';

@Component({
  imports: [AuthFrame],
  template: `<app-auth-frame heading="Sign in" description="With your account"
    >form</app-auth-frame
  >`,
})
class Host {}

describe('AuthFrame', () => {
  it('shows the logo above the card, with the heading and the content', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-laris-mark svg path')).toBeTruthy();
    expect(el.textContent).toContain('Laris');
    expect(el.querySelector('h1')?.textContent).toBe('Sign in');
    expect(el.querySelector('main')?.textContent).toContain('form');
  });
});
