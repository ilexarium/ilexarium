import { TestBed } from '@angular/core/testing';
import type { PublicUser } from '@homelab/shared';
import { OWNER } from '../../core/auth/testing';
import { initialsOf, UserAvatar } from './user-avatar';

const user = (changes: Partial<PublicUser>): PublicUser => ({ ...OWNER, ...changes });

describe('initialsOf', () => {
  it.each([
    [user({}), 'OW'],
    [user({ displayName: 'Anna Berg' }), 'AB'],
    [user({ displayName: 'anna maria berg' }), 'AB'],
    [user({ displayName: 'Prince' }), 'PR'],
    [user({ displayName: 'أحمد علي' }), 'أع'],
    [user({ displayName: '  ' }), 'OW'],
    [null, '?'],
  ])('%#: %j → %s', (who, initials) => {
    expect(initialsOf(who)).toBe(initials);
  });

  it('keeps letters made of two UTF-16 units whole', () => {
    expect(initialsOf(user({ displayName: '𝒜lice 𝒞ooper' }))).toBe('𝒜𝒞');
  });
});

describe('UserAvatar', () => {
  it('shows the initials, hidden from screen readers (the name is next to it)', async () => {
    const fixture = TestBed.createComponent(UserAvatar);
    fixture.componentRef.setInput('user', user({ displayName: 'Anna Berg' }));
    await fixture.whenStable();
    const fallback = (fixture.nativeElement as HTMLElement).querySelector('[hlmAvatarFallback]')!;
    expect(fallback.textContent!.trim()).toBe('AB');
    expect(fallback.getAttribute('aria-hidden')).toBe('true');
  });
});
