import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { AuthStore } from '../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../core/auth/testing';
import { FilesApi } from '../../core/files/files-api';
import { UploadsStore } from '../../core/files/uploads-store';
import { stubScreenWidth } from '../testing';
import { UploadsPanel } from './uploads-panel';

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const dialogButton = (text: string) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent!.includes(text));
const file = (name: string) => new File([name], name);

async function render() {
  const auth = fakeAuthApi({ user: OWNER });
  const api = { upload: vi.fn((_folder: string, _file: File, _replace: boolean) => of(1)) };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), auth.provider, { provide: FilesApi, useValue: api }],
  });
  await TestBed.inject(AuthStore).load();
  const fixture = TestBed.createComponent(UploadsPanel);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const store = TestBed.inject(UploadsStore);
  const leaving = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { fixture, el, api, store, leaving };
}

describe('UploadsPanel', () => {
  let restoreScreen: () => void;
  beforeEach(() => (restoreScreen = stubScreenWidth(1440)));
  afterEach(() => {
    restoreScreen();
    document.querySelectorAll('.cdk-overlay-container').forEach((e) => e.remove());
  });

  it('shows nothing without uploads', async () => {
    const { el } = await render();
    expect(el.querySelector('section')).toBeNull();
  });

  it('counts the files with their progress; once all are there, a close button clears the list', async () => {
    const { el, api, store, fixture } = await render();
    const first = new Subject<number>();
    api.upload.mockReturnValueOnce(first);
    store.upload({ folder: '/home/anna', files: [file('a.txt'), file('b.txt')], replace: false });
    first.next(0.42);
    await fixture.whenStable();
    expect(el.querySelector('h2')!.textContent).toContain('Uploading 1 of 2');
    expect(el.textContent).toContain('42 %');
    expect(el.textContent).toContain('Waiting');
    expect(el.querySelector('li [dir="ltr"]')!.textContent).toBe('a.txt');
    expect(el.querySelector('button[aria-label="Close the list of uploads"]')).toBeNull();
    first.complete();
    await fixture.whenStable();
    expect(el.querySelector('h2')!.textContent).toContain('Uploads finished');
    expect(el.textContent).toContain('Uploaded');
    el.querySelector<HTMLButtonElement>('button[aria-label="Close the list of uploads"]')!.click();
    await fixture.whenStable();
    expect(el.querySelector('section')).toBeNull();
  });

  it('a failed file is marked', async () => {
    const { el, api, store, fixture } = await render();
    api.upload.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 403, error: { message: 'x' } })),
    );
    store.upload({ folder: '/', files: [file('a.txt')], replace: false });
    await fixture.whenStable();
    expect(el.textContent).toContain('Failed');
  });

  it('the list hides and shows again', async () => {
    const { el, api, store, fixture } = await render();
    api.upload.mockReturnValueOnce(new Subject<number>());
    store.upload({ folder: '/', files: [file('a.txt')], replace: false });
    await fixture.whenStable();
    const toggle = el.querySelector<HTMLButtonElement>('button[aria-label="Hide the uploads"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    await fixture.whenStable();
    expect(el.querySelector<HTMLElement>('ul')!.hidden).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Show the uploads');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('on a phone: across the bottom; on wider screens: in the end corner', async () => {
    restoreScreen();
    restoreScreen = stubScreenWidth(375);
    const { el, api, store, fixture } = await render();
    api.upload.mockReturnValueOnce(new Subject<number>());
    store.upload({ folder: '/', files: [file('a.txt')], replace: false });
    await fixture.whenStable();
    const panel = el.querySelector('section')!;
    expect(panel.classList).toContain('inset-x-0');
    expect(panel.classList).toContain('sm:end-4');
    expect(panel.classList).toContain('sm:w-96');
    expect(panel.className).not.toMatch(/\b(left|right)-/);
  });

  it('asks before replacing taken names, showing where; Replace uploads them again', async () => {
    const { api, store, fixture } = await render();
    api.upload.mockReturnValueOnce(
      throwError(
        () => new HttpErrorResponse({ status: 409, error: { message: 'x', code: 'file_exists' } }),
      ),
    );
    const notes = file('notes.txt');
    store.upload({ folder: '/home/anna', files: [notes], replace: false });
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Replace notes.txt?'));
    expect(dialog()!.textContent).toContain('/home/anna/notes.txt');
    dialogButton('Replace')!.click();
    expect(api.upload).toHaveBeenLastCalledWith('/home/anna', notes, true);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await fixture.whenStable();
  });

  it('kept: nothing more uploaded', async () => {
    const { api, store } = await render();
    api.upload.mockReturnValue(
      throwError(
        () => new HttpErrorResponse({ status: 409, error: { message: 'x', code: 'file_exists' } }),
      ),
    );
    store.upload({ folder: '/srv', files: [file('one.txt'), file('two.txt')], replace: false });
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Replace these files?'));
    dialogButton('Keep it')!.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(store.clashes()).toEqual([]);
    expect(api.upload).toHaveBeenCalledTimes(2);
  });

  it('leaving the site asks first, only while a file uploads', async () => {
    const { api, store, fixture, leaving } = await render();
    expect(leaving()).toBe(false);
    const running = new Subject<number>();
    api.upload.mockReturnValueOnce(running);
    store.upload({ folder: '/', files: [file('a.txt')], replace: false });
    await fixture.whenStable();
    expect(leaving()).toBe(true);
    running.complete();
    await fixture.whenStable();
    expect(leaving()).toBe(false);
  });
});
