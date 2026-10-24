import { HttpErrorResponse } from '@angular/common/http';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ProfileUpdate, PublicUser } from '@laris/shared';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../core/auth/testing';
import { ProfileApi } from '../../core/profile/profile-api';
import { PICTURE_ENCODER } from './picture';
import { ProfileDialog } from './profile-dialog';
import { SOURCE_MAX_BYTES } from './profile-dialog.constants';

@Component({
  imports: [ProfileDialog],
  template: `<laris-profile-dialog
    [open]="open()"
    (closed)="open.set(false); closings = closings + 1"
  />`,
})
class Host {
  readonly open = signal(false);
  closings = 0;
}

const SAVED: PublicUser = { ...OWNER, displayName: 'Anna', email: 'anna@example.com' };
const DRAWN = new Blob(['drawn'], { type: 'image/webp' });

describe('ProfileDialog', () => {
  let api: {
    update: ReturnType<typeof vi.fn>;
    setAvatar: ReturnType<typeof vi.fn>;
    removeAvatar: ReturnType<typeof vi.fn>;
  };
  let encode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  async function setup(user: PublicUser = SAVED) {
    api = {
      update: vi.fn((body: ProfileUpdate) =>
        of({
          user: { ...TestBed.inject(AuthStore).user()!, ...body },
        }),
      ),
      setAvatar: vi.fn(() =>
        of({
          user: { ...TestBed.inject(AuthStore).user()!, avatar: '/api/profile/avatar?v=2' },
        }),
      ),
      removeAvatar: vi.fn(() =>
        of({
          user: { ...TestBed.inject(AuthStore).user()!, avatar: null },
        }),
      ),
    };
    encode = vi.fn(async () => DRAWN);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        fakeAuthApi({ user }).provider,
        { provide: ProfileApi, useValue: api },
        { provide: PICTURE_ENCODER, useValue: encode },
      ],
    });
    await TestBed.inject(AuthStore).load();
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.open.set(true);
    await fixture.whenStable();
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    const button = (text: string) =>
      [...dialog().querySelectorAll('button')].find((b) => b.textContent!.trim() === text)!;
    const field = (id: string) => dialog().querySelector<HTMLInputElement>(`#${id}`)!;
    const chooseFile = async (file: File) => {
      const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    };
    /** Types into the dialog's field, as a user would. */
    const typeInto = (_: unknown, id: string, value: string) => {
      field(id).value = value;
      field(id).dispatchEvent(new Event('input'));
    };
    const save = async () => {
      button('Save').click();
      await fixture.whenStable();
    };
    return { fixture, dialog, button, field, chooseFile, save, typeInto };
  }

  it('opens with the saved name and address', async () => {
    const { dialog, field } = await setup();
    expect(dialog().textContent).toContain('Edit profile');
    expect(field('displayName').value).toBe('Anna');
    expect(field('email').value).toBe('anna@example.com');
  });

  it('saves only the fields that changed, and closes', async () => {
    const { fixture, save, typeInto } = await setup();
    typeInto(fixture, 'displayName', 'Anna Berg');
    await save();
    expect(api.update).toHaveBeenCalledWith({ displayName: 'Anna Berg' });
    expect(api.setAvatar).not.toHaveBeenCalled();
    expect(TestBed.inject(AuthStore).user()?.displayName).toBe('Anna Berg');
    expect(fixture.componentInstance.closings).toBe(1);
  });

  it('sends nothing when nothing changed, and closes', async () => {
    const { fixture, save, typeInto } = await setup();
    await save();
    expect(api.update).not.toHaveBeenCalled();
    expect(fixture.componentInstance.closings).toBe(1);
  });

  it('clears a field by sending it empty', async () => {
    const { fixture, save, typeInto } = await setup();
    typeInto(fixture, 'email', '');
    await save();
    expect(api.update).toHaveBeenCalledWith({ email: '' });
  });

  it('shows a field’s problem and sends nothing', async () => {
    const { fixture, dialog, save, typeInto } = await setup();
    typeInto(fixture, 'email', 'not-an-address');
    await save();
    expect(api.update).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('An email address, like me@example.com');
    expect(fixture.componentInstance.closings).toBe(0);
  });

  it('draws a chosen picture, previews it, and uploads it on save', async () => {
    const { fixture, dialog, chooseFile, save } = await setup();
    const file = new File(['photo'], 'me.jpg', { type: 'image/jpeg' });
    await chooseFile(file);
    expect(encode).toHaveBeenCalledWith(file);
    expect(dialog().textContent).toContain('Remove picture');
    expect(api.setAvatar).not.toHaveBeenCalled(); // only on save
    await save();
    expect(api.setAvatar).toHaveBeenCalledWith(DRAWN);
    expect(TestBed.inject(AuthStore).user()?.avatar).toBe('/api/profile/avatar?v=2');
    expect(fixture.componentInstance.closings).toBe(1);
  });

  it('says so when a file can’t be used, without uploading', async () => {
    const { dialog, chooseFile } = await setup();
    encode.mockRejectedValueOnce(new Error('not an image'));
    await chooseFile(new File(['<svg/>'], 'x.svg'));
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('isn’t a picture');
  });

  it('refuses a huge file before reading it', async () => {
    const { dialog, chooseFile } = await setup();
    const huge = new File(['x'], 'huge.jpg');
    Object.defineProperty(huge, 'size', { value: SOURCE_MAX_BYTES + 1 });
    await chooseFile(huge);
    expect(encode).not.toHaveBeenCalled();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('too large');
  });

  it('removes the saved picture on save', async () => {
    const { button, save } = await setup({ ...SAVED, avatar: '/api/profile/avatar?v=1' });
    button('Remove picture').click();
    await save();
    expect(api.removeAvatar).toHaveBeenCalled();
    expect(TestBed.inject(AuthStore).user()?.avatar).toBeNull();
  });

  it('doesn’t send the picture again when the fields fail after it was saved', async () => {
    const { fixture, chooseFile, save, typeInto } = await setup();
    await chooseFile(new File(['photo'], 'me.jpg'));
    typeInto(fixture, 'displayName', 'Anna Berg');
    api.update.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 0 })));
    await save();
    expect(fixture.componentInstance.closings).toBe(0);
    expect(TestBed.inject(AuthStore).user()?.avatar).toBe('/api/profile/avatar?v=2');
    // A server error stays on the form until a value changes (Signal Forms): the person edits again.
    typeInto(fixture, 'displayName', 'Anna Berg-Lund');
    await save();
    expect(api.setAvatar).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.closings).toBe(1);
  });

  it('shows the server’s refusal of the picture and stays open', async () => {
    const { fixture, dialog, chooseFile, save } = await setup();
    api.setAvatar.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({ status: 400, error: { message: 'x', code: 'invalid_picture' } }),
      ),
    );
    await chooseFile(new File(['photo'], 'me.png'));
    await save();
    expect(dialog().textContent).toContain('The picture couldn’t be used');
    expect(fixture.componentInstance.closings).toBe(0);
  });

  it('closes without saving on Cancel, and starts again from the saved profile', async () => {
    const { fixture, button, field, typeInto } = await setup();
    typeInto(fixture, 'displayName', 'Changed');
    button('Cancel').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.closings).toBe(1);
    expect(api.update).not.toHaveBeenCalled();
    fixture.componentInstance.open.set(true);
    await fixture.whenStable();
    expect(field('displayName').value).toBe('Anna');
  });

  it('labels its close button in the language', async () => {
    const { dialog } = await setup();
    expect(dialog().querySelector('[data-slot="dialog-close"] .sr-only')!.textContent).toBe(
      'Close',
    );
  });
});
