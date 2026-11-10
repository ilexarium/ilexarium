import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Disk, DiskPartition, DisksStatus } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { of, throwError } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { DisksApi } from '../../../core/disks/disks-api';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { fakeSockets } from '../../../core/realtime/testing';
import { DisksPage } from './disks-page';

const part = (change: Partial<DiskPartition>): DiskPartition => ({
  device: 'sdx1',
  uuid: '4E21-9A07',
  label: 'Holiday Photos',
  fsType: 'exfat',
  sizeBytes: 5e11,
  state: 'available',
  mountPoint: null,
  managed: false,
  usedForBackups: false,
  duplicateUuid: false,
  ...change,
});

const usb = (partitions: DiskPartition[]): Disk => ({
  device: 'sdx',
  model: 'Portable SSD',
  sizeBytes: 1e12,
  removable: true,
  system: false,
  partitions,
});

const systemDisk: Disk = {
  device: 'vda',
  model: null,
  sizeBytes: 1e11,
  removable: false,
  system: true,
  partitions: [
    part({
      device: 'vda1',
      uuid: 'root',
      label: 'root',
      fsType: 'ext4',
      state: 'system',
      mountPoint: '/',
    }),
  ],
};

const status = (disks: Disk[], disconnected: DisksStatus['disconnected'] = []): DisksStatus => ({
  disks,
  disconnected,
});

async function render(start: DisksStatus) {
  const auth = fakeAuthApi({ user: OWNER });
  const sockets = fakeSockets();
  const api = {
    status: vi.fn(() => of(start)),
    mount: vi.fn(() => of({ mountPoint: '/mnt/holiday-photos' })),
    unmount: vi.fn(() => of(undefined)),
  };
  // Signed in to Linux with sudo at hand: every action goes straight through.
  const asPerson = vi.fn(<T>(action: () => Promise<T>) => action());
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      auth.provider,
      sockets.provider,
      { provide: DisksApi, useValue: api },
      { provide: LinuxSessionStore, useValue: { asPerson } },
    ],
  });
  await TestBed.inject(AuthStore).load();
  TestBed.inject(RealtimeService).connect();
  const socket = sockets.latest();
  socket.open();
  const fixture = TestBed.createComponent(DisksPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const push = async (data: DisksStatus) => {
    socket.receive({ event: 'disks:update', data });
    await fixture.whenStable();
  };
  const button = (text: string, root: ParentNode = el) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.trim().startsWith(text),
    );
  return { fixture, el, api, asPerson, socket, push, button };
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

describe('DisksPage', () => {
  it('lists each disk with its partitions, the system disk shown but never offered', async () => {
    const { el, socket } = await render(
      status([
        usb([
          part({}),
          part({
            device: 'sdx2',
            uuid: 'w',
            label: 'Windows',
            fsType: 'ntfs',
            state: 'unsupported',
          }),
        ]),
        systemDisk,
      ]),
    );
    expect(socket.sent).toContainEqual({ event: 'subscribe', data: { topic: 'disks' } });
    const cards = [...el.querySelectorAll('section')];
    expect(cards[0].textContent).toContain('Portable SSD');
    expect(cards[0].textContent).toContain('Removable');
    expect(cards[0].textContent).toContain('Holiday Photos');
    expect(cards[0].textContent).toContain('Not mounted');
    expect(cards[0].textContent).toContain('Only ext4, XFS, Btrfs and exFAT can be mounted here.');
    // Only the supported partition can be mounted.
    expect(cards[0].querySelectorAll('button')).toHaveLength(1);
    expect(cards[1].textContent).toContain('Disk vda');
    expect(cards[1].textContent).toContain('System disk');
    expect(cards[1].querySelectorAll('button')).toHaveLength(0);
  });

  it('offers no mount for a disk another one shares its ID with (a copied disk)', async () => {
    const { el } = await render(status([usb([part({ duplicateUuid: true })])]));
    expect(el.querySelector('section button')).toBeNull();
    expect(el.textContent).toContain('Another disk has the same ID');
  });

  it('mounts a disk as the person at a folder suggested from its label, the top folder theirs when asked', async () => {
    const success = vi.spyOn(toast, 'success');
    const { api, asPerson, fixture, button } = await render(status([usb([part({})])]));
    button('Mount')!.click();
    await fixture.whenStable();
    const folder = dialog()!.querySelector<HTMLInputElement>('#mount-point')!;
    expect(folder.value).toBe('/mnt/holiday-photos');
    expect(dialog()!.textContent).toContain('It stays mounted after a restart.');
    dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await fixture.whenStable();
    button('Mount', dialog()!.querySelector('form')!)!.click();
    await vi.waitFor(() =>
      expect(api.mount).toHaveBeenCalledWith({
        uuid: '4E21-9A07',
        mountPoint: '/mnt/holiday-photos',
        makeMine: true,
      }),
    );
    expect(asPerson).toHaveBeenCalled();
    await fixture.whenStable();
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('/mnt/holiday-photos is mounted.'));
  });

  it('refuses a system folder, and shows the server’s refusal on the folder', async () => {
    const { api, fixture, button } = await render(status([usb([part({})])]));
    button('Mount')!.click();
    await fixture.whenStable();
    const folder = dialog()!.querySelector<HTMLInputElement>('#mount-point')!;
    folder.value = '/etc/photos';
    folder.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Mount', dialog()!.querySelector('form')!)!.click();
    await fixture.whenStable();
    expect(api.mount).not.toHaveBeenCalled();
    expect(dialog()!.textContent).toContain('not / or a system folder');

    api.mount.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: {
              message: 'Validation failed',
              errors: [{ field: 'mountPoint', code: 'mount_point_in_use', message: 'x' }],
            },
          }),
      ),
    );
    folder.value = '/home/anna/photos';
    folder.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Mount', dialog()!.querySelector('form')!)!.click();
    await vi.waitFor(() => expect(dialog()!.textContent).toContain('That folder is in use'));
  });

  it('unmounts a disk mounted here after a confirmation; never the backup disk', async () => {
    const mounted = part({ state: 'mounted', mountPoint: '/mnt/photos', managed: true });
    const backup = part({
      device: 'sdx2',
      uuid: 'b',
      label: 'Backups',
      fsType: 'ext4',
      state: 'mounted',
      mountPoint: '/mnt/usb',
      managed: true,
      usedForBackups: true,
    });
    const { el, api, fixture, button } = await render(status([usb([mounted, backup])]));
    const unmountButtons = [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.textContent?.includes('Unmount'),
    );
    expect(unmountButtons.map((b) => b.disabled)).toEqual([false, true]);
    expect(el.textContent).toContain('Backups are kept here');
    unmountButtons[0].click();
    await fixture.whenStable();
    expect(dialog()!.textContent).toContain('Unmount this disk?');
    expect(dialog()!.textContent).toContain('/mnt/photos');
    button('Unmount', dialog()!)!.click();
    await vi.waitFor(() => expect(api.unmount).toHaveBeenCalledWith('/mnt/photos'));
  });

  it('forgets a disk mounted before that isn’t connected now', async () => {
    const { el, api, fixture, button } = await render(
      status([], [{ mountPoint: '/mnt/old', uuid: 'gone', usedForBackups: false }]),
    );
    expect(el.textContent).toContain('Not connected');
    button('Forget')!.click();
    await fixture.whenStable();
    expect(dialog()!.textContent).toContain('Forget this disk?');
    button('Forget', dialog()!)!.click();
    await vi.waitFor(() => expect(api.unmount).toHaveBeenCalledWith('/mnt/old'));
  });

  it('follows the disks topic: a disk plugged in appears', async () => {
    const { el, push } = await render(status([systemDisk]));
    expect(el.textContent).not.toContain('Portable SSD');
    await push(status([usb([part({})]), systemDisk]));
    expect(el.textContent).toContain('Portable SSD');
  });
});
