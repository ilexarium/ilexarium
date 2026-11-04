import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { LinuxSession, UpdatesStatus } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { updateJob, updatesStatus } from '../../../core/updates/testing';
import { UpdatesApi } from '../../../core/updates/updates-api';
import { UpdatesStore } from '../../../core/updates/updates-store';
import { SignInPrompt } from '../../../layout/sign-in-prompt/sign-in-prompt';
import { SudoDialog } from '../../../layout/sudo-dialog/sudo-dialog';
import { UpdatesPage } from './updates-page';

const ANNA: LinuxSession = {
  username: 'anna',
  home: '/home/anna',
  uid: 1000,
  sudoUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
};
const AVAILABLE = updatesStatus({
  available: {
    version: '0.2.0',
    published: '2026-11-20T10:00:00Z',
    notes: 'Faster <b>backups</b>.',
  },
});
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const buttonIn = (root: ParentNode | null, text: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) =>
    b.textContent!.includes(text),
  );

async function render(status: UpdatesStatus, start = vi.fn(() => of({ id: 'x' }))) {
  const auth = fakeAuthApi({ user: OWNER });
  const api = {
    status: vi.fn(() => of(status)),
    check: vi.fn(() => of(status)),
    setCheckAutomatically: vi.fn(() => of(undefined)),
    start,
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      { provide: UpdatesApi, useValue: api },
      { provide: FilesApi, useValue: { session: vi.fn(() => of({ session: ANNA })) } },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(LinuxSessionStore).check();
  const fixture = TestBed.createComponent(UpdatesPage);
  TestBed.createComponent(SignInPrompt);
  TestBed.createComponent(SudoDialog);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, api, store: TestBed.inject(UpdatesStore) };
}

describe('UpdatesPage', () => {
  it('shows a newer release with its notes as plain text, and updates after confirming', async () => {
    const { fixture, el, api } = await render(AVAILABLE);
    expect(el.textContent).toContain('Laris 0.2.0 is available');
    expect(el.textContent).toContain('Faster <b>backups</b>.');
    expect(el.querySelector('b')).toBeNull();

    buttonIn(el, 'Update to 0.2.0')!.click();
    await fixture.whenStable();
    expect(dialog()!.textContent).toContain('Linux sign-ins and terminals end');
    expect(api.start).not.toHaveBeenCalled();
    buttonIn(dialog(), 'Update')!.click();
    await fixture.whenStable();
    expect(api.start).toHaveBeenCalledWith('0.2.0');
  });

  it('says why an update couldn’t start', async () => {
    const error = vi.spyOn(toast, 'error');
    const { fixture, el } = await render(
      AVAILABLE,
      vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({ status: 409, error: { message: 'x', code: 'update_busy' } }),
        ),
      ),
    );
    buttonIn(el, 'Update to 0.2.0')!.click();
    await fixture.whenStable();
    buttonIn(dialog(), 'Update')!.click();
    await fixture.whenStable();
    expect(error).toHaveBeenCalledWith("Couldn't start the update", {
      description: expect.stringContaining('Something else is running'),
    });
  });

  it('follows a running update: the download, then the restart', async () => {
    const { fixture, el, store } = await render(updatesStatus());
    store.update(
      updatesStatus({
        job: updateJob({ phase: 'download', download: { bytes: 50, total: 100 } }),
      }),
    );
    await fixture.whenStable();
    expect(el.textContent).toContain('Updating to 0.2.0');
    expect(el.querySelector('hlm-progress')).not.toBeNull();
    store.update(updatesStatus({ job: updateJob({ phase: 'stopped' }) }));
    await fixture.whenStable();
    expect(el.textContent).toContain('Laris is restarting');
  });

  it('a rolled-back update says which version runs', async () => {
    const { el } = await render(
      updatesStatus({
        job: updateJob({
          done: { outcome: 'rolled_back', version: '0.1.0', error: 'not_answering' },
          output: ['==> Starting the app'],
        }),
      }),
    );
    expect(el.textContent).toContain('The update to 0.2.0 failed. Laris is back on 0.1.0.');
    expect(el.textContent).toContain("didn't answer within a minute");
    expect(el.querySelector('pre')!.textContent).toContain('==> Starting the app');
  });

  it('up to date: the switch and checking now', async () => {
    const { fixture, el, api } = await render(updatesStatus());
    expect(el.textContent).toContain('Laris is up to date.');
    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(api.setCheckAutomatically).toHaveBeenCalledWith(false);
    buttonIn(el, 'Check now')!.click();
    await fixture.whenStable();
    expect(api.check).toHaveBeenCalled();
  });

  it('an install without an update source says so, without the switch', async () => {
    const { el } = await render(updatesStatus({ configured: false }));
    expect(el.textContent).toContain('doesn’t know where its updates come from'.replace('’', "'"));
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
  });
});
