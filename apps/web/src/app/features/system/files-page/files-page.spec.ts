import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { FileEntry, FileList, FileSummary, LinuxSession } from '@homelab/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { FilesApi } from '../../../core/files/files-api';
import { stubScreenWidth } from '../../../layout/testing';
import { FilesPage } from './files-page';
import { normalizePath, renameTarget } from './files-page-store';

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

const ANNA: LinuxSession = { username: 'anna', home: '/home/anna' };
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
const dialogButton = (text: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent!.includes(text));

function fakeApi(session: LinuxSession | null) {
  const lists = new Map([
    [HOME.path, HOME],
    [PHOTOS.path, PHOTOS],
  ]);
  return {
    session: vi.fn(async () => ({ session })),
    signIn: vi.fn(async () => ANNA),
    signOut: vi.fn(async () => undefined),
    list: vi.fn(async (path: string) => {
      const list = lists.get(path);
      if (!list) throw httpError(404, 'file_not_found');
      return list;
    }),
    summary: vi.fn(async (): Promise<FileSummary> => ({
      type: 'folder',
      files: 41,
      folders: 2,
      bytes: 5 * 1024 ** 2,
      truncated: false,
    })),
    downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,
    upload: vi.fn((_folder: string, _file: File, _replace: boolean) => of(0.5, 1)),
    newFolder: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
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

  it('without a Linux session: the sign-in; signing in opens the home folder', async () => {
    const { el, api, fixture, names } = await render(null);
    expect(el.textContent).toContain('Open your files');
    const [username, password] = el.querySelectorAll<HTMLInputElement>('input');
    username.value = 'anna';
    username.dispatchEvent(new Event('input'));
    password.value = 'secret';
    password.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() =>
      expect(api.signIn).toHaveBeenCalledWith({ username: 'anna', password: 'secret' }),
    );
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/home/anna'));
    await fixture.whenStable();
    expect(names()).toEqual(['Photos', 'music', 'notes.txt']);
    expect(el.textContent).toContain('/home/anna');
  });

  it('a refused sign-in shows why, in the form', async () => {
    const { el, api, fixture } = await render(null);
    api.signIn.mockRejectedValueOnce(httpError(403, 'linux_login_refused'));
    const [username, password] = el.querySelectorAll<HTMLInputElement>('input');
    username.value = 'anna';
    username.dispatchEvent(new Event('input'));
    password.value = 'wrong';
    password.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'Wrong user name or password',
      );
    });
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

  it('uploads with progress; asks before replacing a file that is there', async () => {
    const { el, api, fixture } = await render();
    api.upload
      .mockImplementationOnce(() => of(0.5, 1))
      .mockImplementationOnce(() => throwError(() => httpError(409, 'file_exists')));
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const a = new File(['aaa'], 'a.txt');
    const notes = new File(['new'], 'notes.txt');
    Object.defineProperty(input, 'files', { value: [a, notes], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Replace notes.txt?'));
    expect(api.upload).toHaveBeenCalledWith('/home/anna', a, false);
    fixture.detectChanges();
    expect(el.textContent).toContain('Uploaded');
    dialogButton('Replace')!.click();
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledWith('/home/anna', notes, true));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it('several taken names: one question, keeping them uploads nothing more', async () => {
    const { el, api } = await render();
    api.upload.mockImplementation(() => throwError(() => httpError(409, 'file_exists')));
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [new File(['1'], 'one.txt'), new File(['2'], 'two.txt')];
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Replace these files?'));
    expect(dialog()!.textContent).toContain('one.txt');
    expect(dialog()!.textContent).toContain('two.txt');
    dialogButton('Keep it')!.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(api.upload).toHaveBeenCalledTimes(2);
  });

  it('a Linux session that ended shows the sign-in again', async () => {
    const { el, api, fixture } = await render();
    const error = vi.spyOn(toast, 'error');
    api.list.mockRejectedValueOnce(httpError(403, 'linux_session_required'));
    el.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Open your files');
    });
    expect(error).toHaveBeenCalled();
  });

  it('closes the Linux session', async () => {
    const { el, api, fixture, button } = await render();
    button('Close')!.click();
    await vi.waitFor(() => expect(api.signOut).toHaveBeenCalled());
    await fixture.whenStable();
    expect(el.textContent).toContain('Open your files');
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

describe('paths', () => {
  it.each([
    ['/home//anna/./x', '/home/anna/x'],
    ['/home/anna/../..', '/'],
    ['/../etc', '/etc'],
  ])('normalizePath(%s) = %s', (path, expected) => expect(normalizePath(path)).toBe(expected));

  it('renameTarget: a name stays in the folder; a path from there, or from /', () => {
    expect(renameTarget('/home/anna', 'new.txt')).toBe('/home/anna/new.txt');
    expect(renameTarget('/home/anna', ' ../bob/x ')).toBe('/home/bob/x');
    expect(renameTarget('/home/anna', '/srv/music/x')).toBe('/srv/music/x');
  });
});
