import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { PublicUser } from '@laris/shared';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { ProfileApi } from '../../../core/profile/profile-api';
import { ProfilePage } from './profile-page';

describe('ProfilePage', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  async function setup(user: PublicUser = OWNER) {
    const auth = fakeAuthApi({ user });
    const profiles = { update: vi.fn(async () => ({ user: { ...user, language: 'de' } })) };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), auth.provider, { provide: ProfileApi, useValue: profiles }],
    });
    await TestBed.inject(AuthStore).load();
    const fixture = TestBed.createComponent(ProfilePage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent!.trim().includes(text),
      )!;
    return { fixture, el, button, api: auth.api, profiles };
  }

  it('shows the username, when the account was made, and "Not set" for empty fields', async () => {
    const { el } = await setup();
    expect(el.querySelector('h2')!.textContent!.trim()).toBe('owner');
    expect(el.textContent).toContain('Member since Oct 11, 2026');
    expect(el.textContent).toContain('Not set');
  });

  it('shows the display name and the email address when set', async () => {
    const { el } = await setup({ ...OWNER, displayName: 'Anna Berg', email: 'anna@example.com' });
    expect(el.querySelector('h2')!.textContent!.trim()).toBe('Anna Berg');
    expect(el.textContent).toContain('anna@example.com');
    expect(el.querySelector('span[dir="ltr"]')!.textContent).toBe('owner');
  });

  it('opens the edit dialog', async () => {
    const { fixture, button } = await setup();
    button('Edit').click();
    await fixture.whenStable();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Edit profile');
  });

  it('chooses the language for the account, the current one pressed', async () => {
    const { fixture, el, profiles } = await setup();
    const choices = () => [...el.querySelectorAll<HTMLButtonElement>('fieldset button')];
    expect(choices().map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    choices()[1].click();
    await fixture.whenStable();
    expect(profiles.update).toHaveBeenCalledWith({ language: 'de' });
  });

  it('opens the password dialog', async () => {
    const { fixture, button } = await setup();
    button('Change password').click();
    await fixture.whenStable();
    expect(document.querySelector('[role="dialog"] h2')!.textContent!.trim()).toBe(
      'Change password',
    );
  });

  it('signs out everywhere only after confirming', async () => {
    const { fixture, button, api } = await setup();
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    button('Sign out everywhere').click();
    await fixture.whenStable();
    expect(api.logoutEverywhere).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('this one too');
    [...dialog.querySelectorAll('button')].at(-1)!.click();
    await fixture.whenStable();
    expect(api.logoutEverywhere).toHaveBeenCalled();
  });

  it('stacks the card’s parts on phones and puts them in a row from sm up', async () => {
    const { el } = await setup();
    const row = el.querySelector('section [hlmCardContent]')!;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('sm:flex-row');
  });
});
