import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { FileEntry, FileList, FileSummary, FileText, LinuxSession } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, Subject, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
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
const ROOT_HOME: FileList = {
  path: '/root',
  parent: '/',
  entries: [entry({ name: '.bashrc', owner: 'root' })],
};
/** sudo unlocked (the prompt is the shell's, not this page's). */
const UNLOCKED: LinuxSession = {
  ...ANNA,
  sudoUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
};
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
const menuDownload = () =>
  document.querySelector<HTMLAnchorElement>('a[hlmDropdownMenuItem][download]');
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
    // As root, /root opens too; as the account, Linux refuses it.
    list: vi.fn((path: string, root?: boolean) => {
      if (path === ROOT_HOME.path)
        return root ? of(ROOT_HOME) : throwError(() => httpError(403, 'permission_denied'));
      const list = lists.get(path);
      return list ? of(list) : throwError(() => httpError(404, 'file_not_found'));
    }),
    lockSudo: vi.fn(() => of({ session: { ...ANNA, sudoUntil: null } })),
    summary: vi.fn(() =>
      of<FileSummary>({
        type: 'folder',
        files: 41,
        folders: 2,
        bytes: 5 * 1024 ** 2,
        truncated: false,
      }),
    ),
    downloadUrl: (path: string, root?: boolean) =>
      `/api/files/download?path=${encodeURIComponent(path)}${root ? '&root=true' : ''}`,
    previewUrl: (path: string, root?: boolean) =>
      `/api/files/preview?path=${encodeURIComponent(path)}${root ? '&root=true' : ''}`,
    text: vi.fn((_path: string, _root?: boolean) =>
      of<FileText>({ text: 'PORT=8080\n', truncated: false, size: 10 }),
    ),
    upload: vi.fn((_folder: string, _file: File, _replace: boolean) => of(0.5, 1)),
    newFolder: vi.fn(() => of(undefined)),
    rename: vi.fn(() => of(undefined)),
    delete: vi.fn(() => of(undefined)),
  };
}

/** The page at its route, so the address (`?path=`) works as in the app; `url` as arrived at. */
async function render(session: LinuxSession | null = ANNA, url = '/system/files') {
  const auth = fakeAuthApi({ user: OWNER });
  const api = fakeApi(session);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'system/files', component: FilesPage }]),
      auth.provider,
      { provide: FilesApi, useValue: api },
    ],
  });
  await TestBed.inject(AuthStore).load();
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url, FilesPage);
  // The page's own element and injector (its store), and the harness's change detection.
  const fixture = {
    whenStable: () => harness.fixture.whenStable(),
    detectChanges: () => harness.fixture.detectChanges(),
    get debugElement() {
      return harness.routeDebugElement!;
    },
  };
  await fixture.whenStable();
  await vi.waitFor(() => expect(api.session).toHaveBeenCalled());
  await fixture.whenStable();
  const el = harness.routeNativeElement!;
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
  /** Opens an entry's menu without choosing anything. */
  const openMenu = async (name: string) => {
    el.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!.click();
    await fixture.whenStable();
  };
  return { fixture, el, api, button, names, menu, openMenu };
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
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna', false));
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

  it('opens folders and links to folders, goes up', async () => {
    const { el, api, fixture, button } = await render();
    expect(el.querySelectorAll('tbody tr')[2].querySelector('td')!.textContent).toMatch(
      /2(\.0)? kB/,
    );
    button('Photos')!.click();
    await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna/Photos', false));
    await fixture.whenStable();
    expect(el.textContent).toContain('This folder is empty.');
    el.querySelector<HTMLButtonElement>('button[aria-label="Up one folder"]')!.click();
    await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna', false));
    await fixture.whenStable();
    button('music')!.click();
    // The fake has no music folder: opened, then (not found) home again.
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna/music', false));
  });

  describe('the preview', () => {
    const preview = () => document.querySelector<HTMLElement>('[role="dialog"]');

    it('a file clicked shows its text, machine text, with Download (an attachment)', async () => {
      const { api, fixture, button } = await render();
      button('notes.txt')!.click();
      await vi.waitFor(() => expect(preview()).not.toBeNull());
      await fixture.whenStable();
      expect(api.text).toHaveBeenCalledWith('/home/anna/notes.txt', false);
      const text = preview()!.querySelector('pre')!;
      expect(text.textContent).toBe('PORT=8080\n');
      expect(text.getAttribute('dir')).toBe('ltr');
      expect(preview()!.textContent).toContain('notes.txt');
      expect(preview()!.textContent).not.toContain('Showing the first 262 kB');
      expect(preview()!.querySelector('a[download]')!.getAttribute('href')).toBe(
        '/api/files/download?path=%2Fhome%2Fanna%2Fnotes.txt',
      );
      [...preview()!.querySelectorAll('button')]
        .find((b) => b.textContent!.trim() === 'Close')!
        .click();
      await vi.waitFor(() => expect(preview()).toBeNull());
      expect(fixture.debugElement.injector.get(FilesPageStore).preview()).toBeNull();
    });

    it('a long text says only its start is shown', async () => {
      const { api, fixture, button } = await render();
      api.text.mockReturnValueOnce(of({ text: 'a'.repeat(100), truncated: true, size: 10 ** 7 }));
      button('notes.txt')!.click();
      await vi.waitFor(() => expect(preview()?.querySelector('pre')).toBeTruthy());
      await fixture.whenStable();
      expect(preview()!.textContent).toContain('Showing the first 262 kB');
    });

    it('a binary file: can’t be previewed, Download offered', async () => {
      const { api, fixture, button } = await render();
      api.text.mockReturnValueOnce(throwError(() => httpError(409, 'not_text')));
      button('notes.txt')!.click();
      await vi.waitFor(() =>
        expect(preview()?.textContent).toContain('This file can’t be previewed.'),
      );
      await fixture.whenStable();
      expect(preview()!.querySelector('pre')).toBeNull();
      expect(preview()!.querySelector('a[download]')).not.toBeNull();
    });

    it('an image by its name: shown from the checked preview address; refused, said so', async () => {
      const { api, fixture } = await render();
      const store = fixture.debugElement.injector.get(FilesPageStore);
      store.openPreview(entry({ name: 'cat.PNG' }));
      await vi.waitFor(() => expect(preview()?.querySelector('img')).toBeTruthy());
      await fixture.whenStable();
      const image = preview()!.querySelector('img')!;
      expect(image.getAttribute('src')).toBe('/api/files/preview?path=%2Fhome%2Fanna%2Fcat.PNG');
      expect(api.text).not.toHaveBeenCalled();
      image.dispatchEvent(new Event('error'));
      await fixture.whenStable();
      expect(preview()!.textContent).toContain('This file can’t be previewed.');
    });

    it('an image larger than the server shows: said so, not asked for', async () => {
      const { fixture } = await render();
      const store = fixture.debugElement.injector.get(FilesPageStore);
      store.openPreview(entry({ name: 'huge.jpg', size: 30 * 1024 ** 2 }));
      await vi.waitFor(() => expect(preview()?.textContent).toContain('Too large to preview'));
      await fixture.whenStable();
      expect(preview()!.textContent).toMatch(/at most 2[01](\.\d)? MB/);
      expect(preview()!.querySelector('img')).toBeNull();
    });

    it('closed while the text loads: stays closed when it arrives', async () => {
      const { api, fixture, button } = await render();
      const late = new Subject<FileText>();
      api.text.mockReturnValueOnce(late);
      button('notes.txt')!.click();
      await vi.waitFor(() => expect(preview()).not.toBeNull());
      await fixture.whenStable();
      [...preview()!.querySelectorAll('button')]
        .find((b) => b.textContent!.trim() === 'Close')!
        .click();
      late.next({ text: 'late', truncated: false, size: 4 });
      late.complete();
      await vi.waitFor(() => expect(preview()).toBeNull());
      await fixture.whenStable();
      expect(preview()).toBeNull();
    });

    it('locking root closes a root file’s preview', async () => {
      const { fixture, button } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(button('As root')).toBeDefined());
      await fixture.whenStable();
      const store = fixture.debugElement.injector.get(FilesPageStore);
      store.openPreview(HOME.entries[2]);
      await vi.waitFor(() => expect(store.preview()?.content.kind).toBe('text'));
      store.lockRoot();
      expect(store.preview()).toBeNull();
    });

    it('from the file’s menu; Download is there too', async () => {
      const { api, openMenu } = await render();
      await openMenu('notes.txt');
      expect(menuDownload()!.getAttribute('href')).toBe(
        '/api/files/download?path=%2Fhome%2Fanna%2Fnotes.txt',
      );
      [...document.querySelectorAll<HTMLElement>('[hlmDropdownMenuItem]')]
        .find((b) => b.textContent!.includes('Preview'))!
        .click();
      await vi.waitFor(() => expect(api.text).toHaveBeenCalledWith('/home/anna/notes.txt', false));
    });

    it('as root: read as root', async () => {
      const { api, fixture, button } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(button('As root')).toBeDefined());
      await fixture.whenStable();
      button('notes.txt')!.click();
      await vi.waitFor(() => expect(api.text).toHaveBeenCalledWith('/home/anna/notes.txt', true));
    });
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
    await vi.waitFor(() =>
      expect(api.newFolder).toHaveBeenCalledWith('/home/anna', 'Taxes', false),
    );
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
      expect(api.rename).toHaveBeenCalledWith('/home/anna/notes.txt', '/home/bob/notes.txt', false),
    );
    await fixture.whenStable();
  });

  it('deletes after confirming, with how much is in a folder', async () => {
    const { api, fixture, menu } = await render();
    const success = vi.spyOn(toast, 'success');
    await menu('Photos', 'Delete');
    await vi.waitFor(() => expect(dialog()!.textContent).toContain('43 items, 5.2 MB'));
    expect(dialog()!.textContent).toContain('Delete Photos?');
    expect(api.summary).toHaveBeenCalledWith('/home/anna/Photos', false);
    dialogButton('Delete')!.click();
    await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith('/home/anna/Photos', false));
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
    expect(api.upload).toHaveBeenCalledWith('/home/anna', a, false, false);
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
    expect(api.list).toHaveBeenLastCalledWith('/home/anna', false);
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
    expect(api.upload).toHaveBeenCalledWith('/home/anna', b, false, false);
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

  describe('the folder in the address', () => {
    const url = () => TestBed.inject(Router).url;
    const HOME_URL = '/system/files?path=%2Fhome%2Fanna';

    it('arriving without one: the home folder, in the address in its place', async () => {
      const { names } = await render();
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      expect(names()).toEqual(['Photos', 'music', 'notes.txt']);
    });

    it('opening a folder and going up change the address; an address change (back) opens its folder', async () => {
      const { el, api, fixture, names } = await render();
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      (el.querySelector('tbody th button') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(url()).toBe('/system/files?path=%2Fhome%2Fanna%2FPhotos'));
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna/Photos', false));
      await fixture.whenStable();
      el.querySelector<HTMLButtonElement>('button[aria-label="Up one folder"]')!.click();
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      // What the browser's back and forward do: the address changes, the folder follows.
      await TestBed.inject(Router).navigateByUrl('/system/files?path=%2Fhome%2Fanna%2FPhotos');
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna/Photos', false));
      await TestBed.inject(Router).navigateByUrl(HOME_URL);
      await vi.waitFor(() => expect(names()).toEqual(['Photos', 'music', 'notes.txt']));
    });

    it('a bookmarked folder opens as it is', async () => {
      const { api } = await render(ANNA, '/system/files?path=%2Fhome%2Fanna%2FPhotos');
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna/Photos', false));
      expect(url()).toBe('/system/files?path=%2Fhome%2Fanna%2FPhotos');
      expect(api.list).not.toHaveBeenCalledWith('/home/anna', false);
    });

    it('signing in on a bookmarked folder opens it, not the home folder', async () => {
      const { api } = await render(null, '/system/files?path=%2Fhome%2Fanna%2FPhotos');
      signIn('anna', 'secret');
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna/Photos', false));
      expect(api.list).not.toHaveBeenCalledWith('/home/anna', false);
      expect(url()).toBe('/system/files?path=%2Fhome%2Fanna%2FPhotos');
    });

    it('a folder that doesn’t open: why in a toast, then home in its place', async () => {
      const error = vi.spyOn(toast, 'error').mockReturnValue(0);
      const { names } = await render(ANNA, '/system/files?path=%2Fgone');
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      expect(error).toHaveBeenCalled();
      await vi.waitFor(() => expect(names()).toEqual(['Photos', 'music', 'notes.txt']));
    });

    it('a folder clicked that fails: the address names the folder still shown, and asking again retries', async () => {
      vi.spyOn(toast, 'error').mockReturnValue(0);
      const { el, api, fixture, names } = await render();
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      api.list.mockReturnValueOnce(throwError(() => httpError(500, 'x')));
      (el.querySelector('tbody th button') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      expect(names()).toEqual(['Photos', 'music', 'notes.txt']);
      await fixture.whenStable();
      (el.querySelector('tbody th button') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(url()).toBe('/system/files?path=%2Fhome%2Fanna%2FPhotos'));
      expect(api.list.mock.calls.filter(([path]) => path === '/home/anna/Photos')).toHaveLength(2);
    });

    it('a folder it may not open: stays in the folder shown, not home', async () => {
      vi.spyOn(toast, 'error').mockReturnValue(0);
      const { api, names } = await render(ANNA, '/system/files?path=%2Fhome%2Fanna%2FPhotos');
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna/Photos', false));
      await TestBed.inject(Router).navigateByUrl('/system/files?path=%2Froot');
      await vi.waitFor(() => expect(url()).toBe('/system/files?path=%2Fhome%2Fanna%2FPhotos'));
      expect(names()).toEqual([]);
      expect(api.list).not.toHaveBeenCalledWith('/home/anna', false);
    });

    it('another account signing in after a sign-out: its home, not the previous account’s folder', async () => {
      const { api, button, fixture } = await render(
        ANNA,
        '/system/files?path=%2Fhome%2Fanna%2FPhotos',
      );
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna/Photos', false));
      button('Close')!.click();
      await vi.waitFor(() => expect(button('Sign in as a Linux user')).toBeDefined());
      await fixture.whenStable();
      api.signIn.mockReturnValueOnce(
        of({ ...ANNA, username: 'bob', home: '/home/bob', uid: 1501 }),
      );
      api.list.mockClear();
      button('Sign in as a Linux user')!.click();
      await fixture.whenStable();
      signIn('bob', 'secret');
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/bob', false));
      expect(api.list).not.toHaveBeenCalledWith('/home/anna/Photos', false);
    });

    it('not a path: home in its place', async () => {
      await render(ANNA, '/system/files?path=relative');
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
    });

    it('refresh and changes leave the address as it is', async () => {
      const { el, api, fixture } = await render();
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      el.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      await fixture.whenStable();
      await fixture.debugElement.injector.get(FilesPageStore).newFolder('Taxes');
      expect(api.newFolder).toHaveBeenCalled();
      expect(url()).toBe(HOME_URL);
    });

    it('as root, nothing of it in the address', async () => {
      const { api, button } = await render(UNLOCKED);
      await vi.waitFor(() => expect(url()).toBe(HOME_URL));
      button('As anna')!.click();
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna', true));
      expect(url()).toBe(HOME_URL);
    });
  });

  describe('as administrator', () => {
    const warning = (el: HTMLElement) => el.textContent!.includes('You’re working as root');

    it('starts as the account; unlocked, the folder as root with a warning; locked, back as the account', async () => {
      const { el, api, fixture, button, names, openMenu } = await render(UNLOCKED);
      expect(button('As anna')).toBeDefined();
      expect(warning(el)).toBe(false);
      button('As anna')!.click();
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna', true));
      await fixture.whenStable();
      expect(warning(el)).toBe(true);
      expect(button('As root')).toBeDefined();

      // Everything as root now: folders, actions, downloads.
      api.list.mockClear();
      (el.querySelector('tbody th button') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna/Photos', true));
      await fixture.whenStable();
      el.querySelector<HTMLButtonElement>('button[aria-label="Up one folder"]')?.click();
      await vi.waitFor(() => expect(names()).toContain('notes.txt'));
      await openMenu('notes.txt');
      expect(menuDownload()!.getAttribute('href')).toContain('root=true');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await fixture.whenStable();

      button('As root')!.click();
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna'));
      await fixture.whenStable();
      expect(warning(el)).toBe(false);
      expect(button('As anna')).toBeDefined();
    });

    it('locked again in a root-only folder: the account’s home', async () => {
      const { api, fixture, button, names } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna', true));
      await TestBed.inject(Router).navigateByUrl('/system/files?path=%2Froot');
      await vi.waitFor(() => expect(names()).toEqual(['.bashrc']));
      button('As root')!.click();
      await vi.waitFor(() => expect(names()).toEqual(['Photos', 'music', 'notes.txt']));
      expect(TestBed.inject(Router).url).toBe('/system/files?path=%2Fhome%2Fanna');
      await fixture.whenStable();
    });

    it('new folders, renames, deletes and uploads go as root while unlocked', async () => {
      const { api, fixture, button } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(api.list).toHaveBeenLastCalledWith('/home/anna', true));
      await fixture.whenStable();
      const store = fixture.debugElement.injector.get(FilesPageStore);
      await store.newFolder('Taxes');
      expect(api.newFolder).toHaveBeenCalledWith('/home/anna', 'Taxes', true);
      await store.rename(HOME.entries[2], 'old.txt');
      expect(api.rename).toHaveBeenCalledWith('/home/anna/notes.txt', '/home/anna/old.txt', true);
      store.delete(HOME.entries[2]);
      await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith('/home/anna/notes.txt', true));
      const upload = new File(['x'], 'hosts');
      store.upload([upload]);
      await vi.waitFor(() =>
        expect(api.upload).toHaveBeenCalledWith('/home/anna', upload, false, true),
      );
    });

    it('a root listing that answers after locking is never shown as the account’s', async () => {
      const { api, fixture, button, names } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(button('As root')).toBeDefined());
      const late = new Subject<FileList>();
      api.list.mockImplementationOnce(() => late);
      fixture.debugElement.injector.get(FilesPageStore).open('/root');
      button('As root')!.click();
      await vi.waitFor(() => expect(names()).toEqual(['Photos', 'music', 'notes.txt']));
      late.next(ROOT_HOME);
      late.complete();
      await fixture.whenStable();
      expect(names()).toEqual(['Photos', 'music', 'notes.txt']);
    });

    it('sudo locked under a root request: the top bar’s sudo locked too', async () => {
      vi.spyOn(toast, 'info').mockReturnValue(0);
      const { api, button } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(button('As root')).toBeDefined());
      api.list.mockImplementation((path: string, root?: boolean) =>
        root ? throwError(() => httpError(403, 'sudo_required')) : of(HOME),
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      await vi.waitFor(() => expect(TestBed.inject(LinuxSessionStore).sudoMinutes()).toBeNull());
    });

    it('sudo locked under a root request: back to the account, said in a toast', async () => {
      const info = vi.spyOn(toast, 'info').mockReturnValue(0);
      const { el, api, fixture, button } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(button('As root')).toBeDefined());
      api.list.mockImplementation((path: string, root?: boolean) =>
        root ? throwError(() => httpError(403, 'sudo_required')) : of(HOME),
      );
      el.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      await vi.waitFor(() =>
        expect(info).toHaveBeenCalledWith('sudo locked: Files is back to anna.'),
      );
      await fixture.whenStable();
      expect(button('As anna')).toBeDefined();
      expect(warning(el)).toBe(false);
    });

    it('“Lock now” elsewhere while working as root: back to the account', async () => {
      const info = vi.spyOn(toast, 'info').mockReturnValue(0);
      vi.spyOn(toast, 'success').mockReturnValue(0);
      const { el, fixture, button } = await render(UNLOCKED);
      button('As anna')!.click();
      await vi.waitFor(() => expect(button('As root')).toBeDefined());
      TestBed.inject(LinuxSessionStore).lockNow();
      await vi.waitFor(() => expect(info).toHaveBeenCalled());
      await fixture.whenStable();
      expect(warning(el)).toBe(false);
    });

    it('not available on this machine: said in a toast, still as the account', async () => {
      const error = vi.spyOn(toast, 'error').mockReturnValue(0);
      const { el, api, fixture, button } = await render(UNLOCKED);
      api.list.mockImplementation((path: string, root?: boolean) =>
        root ? throwError(() => httpError(403, 'root_files_unavailable')) : of(HOME),
      );
      button('As anna')!.click();
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith('That didn’t work', {
          description: expect.stringContaining('Administrator mode for Files isn’t available'),
        }),
      );
      await fixture.whenStable();
      expect(button('As anna')).toBeDefined();
      expect(warning(el)).toBe(false);
    });
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
