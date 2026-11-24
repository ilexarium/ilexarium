import { TestBed } from '@angular/core/testing';
import { firstValueFrom, type Observable, of } from 'rxjs';
import { AppsApi } from '../../apps/apps-api';
import { LinuxSessionStore } from '../../linux/linux-session-store';
import { BackupsApi } from '../backups-api';
import { BackupsService } from './backups-service';

function setup() {
  const backupsApi = {
    runs: vi.fn(() => of({ runs: [{ id: 'r1' }] })),
    restores: vi.fn(() => of({ restores: [{ id: 's1' }] })),
    setup: vi.fn(() => of({ passphrase: 'words' })),
    removeItem: vi.fn(() => of(null)),
    addItem: vi.fn(() => of({ id: 'i1' })),
  };
  const appsApi = {
    template: vi.fn(() =>
      of({
        template: { id: 'navidrome', version: '2', backup: { mode: 'live', skip: ['cache'] } },
        compose: '',
      }),
    ),
  };
  // Signed in, sudo at hand: the action runs at once (null: the prompt was dismissed).
  const asPerson = vi.fn(<T>(action: () => Observable<T>): Observable<T | null> => action());
  TestBed.configureTestingModule({
    providers: [
      { provide: BackupsApi, useValue: backupsApi },
      { provide: AppsApi, useValue: appsApi },
      { provide: LinuxSessionStore, useValue: { asPerson$: asPerson } },
    ],
  });
  return { service: TestBed.inject(BackupsService), backupsApi, appsApi, asPerson };
}

const MUSIC = { name: 'music', folder: '/home/anna/apps/music', template: { id: 'navidrome' } };

describe('BackupsService', () => {
  it('reads runs and restores together, without the Linux sign-in', async () => {
    const { service, asPerson } = setup();
    await expect(firstValueFrom(service.history())).resolves.toEqual({
      runs: [{ id: 'r1' }],
      restores: [{ id: 's1' }],
    });
    expect(asPerson).not.toHaveBeenCalled();
  });

  it('says a change was done even when the server answers nothing (204)', async () => {
    const { service, backupsApi, asPerson } = setup();
    await expect(firstValueFrom(service.removeItem('i1', true))).resolves.toBe(true);
    expect(backupsApi.removeItem).toHaveBeenCalledWith('i1', true);
    expect(asPerson).toHaveBeenCalledTimes(1);
  });

  it('the prompt dismissed: null, nothing sent', async () => {
    const { service, backupsApi, asPerson } = setup();
    asPerson.mockReturnValueOnce(of(null));
    await expect(firstValueFrom(service.removeItem('i1', false))).resolves.toBeNull();
    expect(backupsApi.removeItem).not.toHaveBeenCalled();
  });

  it('sets up with each app’s preset and the folders, as the person', async () => {
    const { service, backupsApi } = setup();
    const settings = { destination: 'd1', schedule: 'daily', retention: { daily: 7 } } as never;
    await expect(
      firstValueFrom(service.setup(settings, [MUSIC as never], ['/srv/photos'])),
    ).resolves.toEqual({ passphrase: 'words' });
    expect(backupsApi.setup).toHaveBeenCalledWith({
      ...(settings as object),
      items: [
        expect.objectContaining({
          kind: 'app',
          project: 'music',
          mode: 'live',
          skip: ['/home/anna/apps/music/cache'],
        }),
        { kind: 'folder', path: '/srv/photos' },
      ],
    });
  });

  it('sets up with folders only (no apps to read presets for)', async () => {
    const { service, backupsApi, appsApi } = setup();
    await firstValueFrom(service.setup({} as never, [], ['/srv/photos']));
    expect(appsApi.template).not.toHaveBeenCalled();
    expect(backupsApi.setup).toHaveBeenCalledWith({
      items: [{ kind: 'folder', path: '/srv/photos' }],
    });
  });

  it('adds an app with its preset and says so', async () => {
    const { service, backupsApi } = setup();
    await expect(firstValueFrom(service.addApp(MUSIC as never))).resolves.toBe(true);
    expect(backupsApi.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'app', project: 'music', mode: 'live' }),
    );
  });
});
