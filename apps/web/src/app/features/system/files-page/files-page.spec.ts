import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { FileEntry, FileList, FileSummary, LinuxSession } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, Subject, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { UploadsStore } from '../../../core/files/uploads-store';
import { stubScreenWidth } from '../../../layout/testing';
import { FilesPage } from './files-page';
import { FilesPageStore } from './files-page-store';

const entry = (change: Partial<FileEntry>): FileEntry => ({
  name: 'notes.txt',
  type: 'file',
  linkTarget: null,
  size: 2048,
  modifiedAt: '2026-10-17T09:30:00.000Z',
  owner: 'anna',
  permissions: 'rw-r--r--',
  ...change,
});

const ANNA: LinuxSession = {
  username: 'anna',
  home: '/home/anna',
  uid: 1500,
  sudoUntil: null,
};
const HOME: FileList = {
  path: '/home/anna',
  parent: '/home',
  entries: [
    entry({ name: 'Photos', type: 'folder', size: 4096, permissions: 'rwxr-xr-x' }),
    entry({ name: 'music', type: 'link', linkTarget: 'folder', size: 12 }),
    entry({}),
  ],
};
const PHOTOS: FileList = { path: '/home/anna/Photos', parent: '/home/anna', entries: [] };
const httpError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { message: 'x', code } });
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const signInDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const signIn = (username: string, password: string) => {
  const [user, pass] = signInDialog()!.querySelectorAll<HTMLInputElement>('input');
  user.value = username;
  user.dispatchEvent(new Event('input'));
  pass.value = password;
  pass.dispatchEvent(new Event('input'));
  signInDialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
};
const dialogButton = (text: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent!.includes(text));

function fakeApi(session: LinuxSession | null) {
  const lists = new Map([
    [HOME.path, HOME],
    [PHOTOS.path, PHOTOS],
  ]);
  return {
    session: vi.fn(() => of({ session })),
    signIn: vi.fn(() => of(ANNA)),
    signOut: vi.fn(() => of(undefined)),
    list: vi.fn((path: string) => {
      const list = lists.get(path);
      return list ? of(list) : throwError(() => httpError(404, 'file_not_found'));
    }),
    summary: vi.fn(() =>
      of<FileSummary>({
        type: 'folder',
        files: 41,
        folders: 2,
        bytes: 5 * 1024 ** 2,
        truncated: false,
      }),
    ),
    downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,
    upload: vi.fn((_folder: string, _file: File, _replace: boolean) => of(0.5, 1)),
    newFolder: vi.fn(() => of(undefined)),
    rename: vi.fn(() => of(undefined)),
    delete: vi.fn(() => of(undefined)),
  };
}

async function render(session: LinuxSession | null = ANNA) {
  const auth = fakeAuthApi({ user: OWNER });
  const api = fakeApi(session);
  TestBed.configureTestingModule({
    providers: [provideRouter([]), auth.provider, { provide: FilesApi, useValue: api }],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(FilesPage);
  await fixture.whenStable();
  await vi.waitFor(() => expect(api.session).toHaveBeenCalled());
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.trim().startsWith(text),
    );
  const names = () =>
    [...el.querySelectorAll('tbody th [dir="ltr"]')].map((s) => s.textContent!.trim());
  const menu = async (name: string, item: string) => {
    el.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!.click();
    await fixture.whenStable();
    [...document.querySelectorAll<HTMLElement>('[hlmDropdownMenuItem], [role="menuitem"]')]
      .find((b) => b.textContent!.includes(item))!
      .click();
    await fixture.whenStable();
  };
  return { fixture, el, api, button, names, menu };
}

describe('FilesPage', () => {
  let restoreScreen: () => void;
  beforeEach(() => (restoreScreen = stubScreenWidth(1440)));
  afterEach(() => {
    restoreScreen();
    document.querySelectorAll('.cdk-overlay-container').forEach((e) => e.remove());
    vi.restoreAllMocks();
  });

  it('without a Linux session: the sign-in opens on its own; signing in opens the home folder', async () => {
    const { el, api, fixture, names } = await render(null);
    expect(signInDialog()!.textContent).toContain('Open your files');
    signIn('anna', 'secret');
    await vi.waitFor(() =>
      expect(api.signIn).toHaveBeenCalledWith({ username: 'anna', password: 'secret' }),
    );
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna'));
    await fixture.whenStable();
    await vi.waitFor(() => expect(signInDialog()).toBeNull());
    expect(names()).toEqual(['Photos', 'music', 'notes.txt']);
    expect(el.textContent).toContain('/home/anna');
  });

  it('with a Linux session: no sign-in', async () => {
    const { names } = await render();
    expect(signInDialog()).toBeNull();
    expect(names()).toEqual(['Photos', 'music', 'notes.txt']);
  });

  it('a refused sign-in shows why, in the dialog', async () => {
    const { api, fixture } = await render(null);
    api.signIn.mockReturnValueOnce(throwError(() => httpError(403, 'linux_login_refused')));
    signIn('anna', 'wrong');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(signInDialog()!.querySelector('[role="alert"]')?.textContent).toContain(
        'Wrong user name or password',
      );
    });
  });

  it('cancelled: the page says what signing in opens, and its button opens the dialog again', async () => {
    const { el, fixture, button } = await render(null);
    [...signInDialog()!.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('Cancel'))!
      .click();
    await vi.waitFor(() => expect(signInDialog()).toBeNull());
    await fixture.whenStable();
    expect(el.textContent).toContain('Open your files');
    button('Sign in as a Linux user')!.click();
    await fixture.whenStable();
    expect(signInDialog()).not.toBeNull();
  });

  it('opens folders and links to folders, goes up; files are download links (attachments)', async () => {
    const { el, api, fixture, button } = await render();
    const file = el.querySelector<HTMLAnchorElement>('tbody a[download]')!;
    expect(file.getAttribute('href')).toBe('/api/files/download?path=%2Fhome%2Fanna%2Fnotes.txt');
    expect(el.querySelectorAll('tbody tr')[2].querySelector('td')!.textContent).toMatch(
      /2(\.0)? kB/,
    );
    button('Photos')!.click();
    await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna/Photos'));
    await fixture.whenStable();
    expect(el.textContent).toContain('This folder is empty.');
    el.querySelector<HTMLButtonElement>('button[aria-label="Up one folder"]')!.click();
    await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna'));
    await fixture.whenStable();
    button('music')!.click();
    await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna/music'));
  });

  it('a folder opened while another one loads: the one opened last is shown', async () => {
    const { fixture, api, names } = await render();
    const slow = new Subject<FileList>();
    api.list.mockReturnValueOnce(slow);
    const store = fixture.debugElement.injector.get(FilesPageStore);
    store.open('/home/anna/Photos');
    store.open('/home/anna');
    slow.next(PHOTOS);
    await fixture.whenStable();
    expect(store.list()?.path).toBe('/home/anna');
    expect(names()).toContain('Photos');
  });

  it('a folder clicked while a delete is under way stays shown (the reload after it doesn’t win)', async () => {
    const { fixture, api } = await render();
    const deleted = new Subject<undefined>();
    api.delete.mockReturnValueOnce(deleted);
    const store = fixture.debugElement.injector.get(FilesPageStore);
    store.delete(HOME.entries[2]);
    store.open('/home/anna/Photos');
    deleted.next(undefined);
    deleted.complete();
    await fixture.whenStable();
    expect(store.list()?.path).toBe('/home/anna/Photos');
  });

  it('makes a new folder through the name dialog', async () => {
    const { api, fixture, button } = await render();
    const success = vi.spyOn(toast, 'success');
    button('New folder')!.click();
    await fixture.whenStable();
    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    input.value = 'Taxes';
    input.dispatchEvent(new Event('input'));
    dialogButton('Create')!.click();
    await vi.waitFor(() => expect(api.newFolder).toHaveBeenCalledWith('/home/anna', 'Taxes'));
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('Folder Taxes created'));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it('a new folder name with "/" is refused before asking the server', async () => {
    const { api, fixture, button } = await render();
    button('New folder')!.click();
    await fixture.whenStable();
    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    input.value = 'a/b';
    input.dispatchEvent(new Event('input'));
    dialogButton('Create')!.click();
    await fixture.whenStable();
    expect(dialog()!.textContent).toContain('A name without “/”');
    expect(api.newFolder).not.toHaveBeenCalled();
  });

  it('renames, or moves with a path (relative to the folder, or from /)', async () => {
    const { api, fixture, menu } = await render();
    await menu('notes.txt', 'Rename or move');
    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('notes.txt');
    input.value = '../bob/notes.txt';
    input.dispatchEvent(new Event('input'));
    dialogButton('Save')!.click();
    await vi.waitFor(() =>
      expect(api.rename).toHaveBeenCalledWith('/home/anna/notes.txt', '/home/bob/notes.txt'),
    );
    await fixture.whenStable();
  });

  it('deletes after confirming, with how much is in a folder', async () => {
    const { api, fixture, menu } = await render();
    const success = vi.spyOn(toast, 'success');
    await menu('Photos', 'Delete');
    await vi.waitFor(() => expect(dialog()!.textContent).toContain('43 items, 5.2 MB'));
    expect(dialog()!.textContent).toContain('Delete Photos?');
    expect(api.summary).toHaveBeenCalledWith('/home/anna/Photos');
    dialogButton('Delete')!.click();
    await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith('/home/anna/Photos'));
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('Photos deleted'));
    await fixture.whenStable();
  });

  it('files chosen go to the uploads, into the folder shown; the folder reloads once they are there', async () => {
    const { el, api, fixture } = await render();
    const uploaded = new Subject<number>();
    api.upload.mockReturnValueOnce(uploaded);
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const a = new File(['aaa'], 'a.txt');
    Object.defineProperty(input, 'files', { value: [a], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(api.upload).toHaveBeenCalledWith('/home/anna', a, false);
    expect(
      TestBed.inject(UploadsStore)
        .uploads()
        .map((u) => u.name),
    ).toEqual(['a.txt']);
    const lists = api.list.mock.calls.length;
    uploaded.next(1);
    uploaded.complete();
    await fixture.whenStable();
    expect(api.list).toHaveBeenCalledTimes(lists + 1);
    expect(api.list).toHaveBeenLastCalledWith('/home/anna');
  });

  it('an upload that lands in another folder than the one shown: no reload', async () => {
    const { api, fixture } = await render();
    const lists = api.list.mock.calls.length;
    TestBed.inject(UploadsStore).upload({
      folder: '/srv',
      files: [new File(['b'], 'b.txt')],
      replace: false,
    });
    await fixture.whenStable();
    expect(api.list).toHaveBeenCalledTimes(lists);
  });

  it('files dropped on the page go to the uploads', async () => {
    const { el, api } = await render();
    const b = new File(['b'], 'b.txt');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [b], types: ['Files'] } });
    el.querySelector('ilex-file-list')!.dispatchEvent(drop);
    expect(api.upload).toHaveBeenCalledWith('/home/anna', b, false);
  });

  it('a new folder whose name is taken: said under the name, no toast; editing the name clears it', async () => {
    const { api, fixture, button } = await render();
    const error = vi.spyOn(toast, 'error');
    api.newFolder.mockReturnValueOnce(throwError(() => httpError(409, 'file_exists')));
    button('New folder')!.click();
    await fixture.whenStable();
    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    input.value = 'Photos';
    input.dispatchEvent(new Event('input'));
    dialogButton('Create')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(dialog()!.textContent).toContain('Something of that name is there already.');
    });
    expect(error).not.toHaveBeenCalled();
    input.value = 'Photos 2';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(dialog()!.textContent).not.toContain('Something of that name is there already.');
  });

  it('a rename Linux refuses: said under the name, the dialog stays open', async () => {
    const { api, fixture, menu } = await render();
    api.rename.mockReturnValueOnce(throwError(() => httpError(403, 'permission_denied')));
    await menu('notes.txt', 'Rename or move');
    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    input.value = '/etc/notes.txt';
    input.dispatchEvent(new Event('input'));
    dialogButton('Save')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(dialog()!.textContent).toContain('Linux doesn’t allow this account to do that.');
    });
    const store = fixture.debugElement.injector.get(FilesPageStore);
    expect(store.pending()).toEqual([]);
  });

  it('a refusal without a text of its own: worded in the app’s language under the name', async () => {
    const { api, fixture, button } = await render();
    api.newFolder.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 500, error: { message: 'Boom' } })),
    );
    button('New folder')!.click();
    await fixture.whenStable();
    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    input.value = 'Taxes';
    input.dispatchEvent(new Event('input'));
    dialogButton('Create')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(dialog()!.textContent).toContain('(500)');
    });
    expect(dialog()!.textContent).not.toContain('Boom');
  });

  it('a new folder after the Linux session ended: the page goes back to its sign-in', async () => {
    const { el, api, fixture, button } = await render();
    api.newFolder.mockReturnValueOnce(throwError(() => httpError(403, 'linux_session_required')));
    button('New folder')!.click();
    await fixture.whenStable();
    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    input.value = 'Taxes';
    input.dispatchEvent(new Event('input'));
    dialogButton('Create')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Open your files');
    });
  });

  it('a delete cancelled: gone from the store as soon as the dialog starts closing', async () => {
    const { fixture, menu } = await render();
    const store = fixture.debugElement.injector.get(FilesPageStore);
    await menu('Photos', 'Delete');
    await vi.waitFor(() => expect(dialog()!.textContent).toContain('43 items'));
    dialogButton('Cancel')!.click();
    expect(store.deleting()).toBeNull();
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it('a Linux session that ended: the sign-in button, without the dialog opening on its own', async () => {
    const { el, api, fixture, button } = await render();
    const error = vi.spyOn(toast, 'error');
    api.list.mockReturnValueOnce(throwError(() => httpError(403, 'linux_session_required')));
    el.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Open your files');
    });
    expect(error).toHaveBeenCalled();
    expect(button('Sign in as a Linux user')).toBeTruthy();
    expect(signInDialog()).toBeNull();
  });

  it('a delete count that fails says why and closes the dialog', async () => {
    const { api, fixture, menu } = await render();
    const error = vi.spyOn(toast, 'error');
    api.summary.mockReturnValueOnce(throwError(() => httpError(403, 'permission_denied')));
    await menu('Photos', 'Delete');
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(error).toHaveBeenCalledWith('That didn’t work', {
      description: 'Linux doesn’t allow this account to do that.',
    });
    expect(api.delete).not.toHaveBeenCalled();
    await fixture.whenStable();
  });

  it('closing that fails keeps the files and says so', async () => {
    const { el, api, fixture, button } = await render();
    const error = vi.spyOn(toast, 'error');
    api.signOut.mockReturnValueOnce(throwError(() => httpError(503, 'ssh_unavailable')));
    button('Close')!.click();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await fixture.whenStable();
    expect(el.textContent).not.toContain('Open your files');
  });

  it('closes the Linux session', async () => {
    const { el, api, fixture, button } = await render();
    button('Close')!.click();
    await vi.waitFor(() => expect(api.signOut).toHaveBeenCalled());
    await fixture.whenStable();
    expect(el.textContent).toContain('Open your files');
    expect(signInDialog()).toBeNull();
  });

  it('on a phone: a list instead of the table', async () => {
    restoreScreen();
    restoreScreen = stubScreenWidth(375);
    const { el } = await render();
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelectorAll('li')).toHaveLength(3);
    expect(el.querySelector('li')!.textContent).toContain('Photos');
  });
});
