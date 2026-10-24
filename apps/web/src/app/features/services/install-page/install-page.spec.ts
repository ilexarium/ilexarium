import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import type { CatalogEntryDetails } from '@laris/shared';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ServicesApi } from '../../../core/services/services-api';
import { submit, textOf } from '../../../shared/forms/testing';
import { InstallPage } from './install-page';

/** An entry with every field type (its texts are added to the test translations below). */
const details: CatalogEntryDetails = {
  meta: {
    schemaVersion: 1,
    id: 'demo',
    version: '1',
    name: 'Demo',
    category: 'tools',
    website: 'https://example.org',
    webPort: 'WEB_PORT',
    dataOwner: { uid: 1000, gid: 1000 },
    fields: [
      { key: 'WEB_PORT', type: 'port', default: 8080 },
      { key: 'MEDIA_DIR', type: 'path', default: '/srv/laris/demo/media', access: 'read' },
      { key: 'DATA_DIR', type: 'path', default: '/srv/laris/demo/data', access: 'write' },
      { key: 'ADMIN_PASSWORD', type: 'secret' },
      { key: 'DB_PASSWORD', type: 'generatedSecret' },
      {
        key: 'LOG_LEVEL',
        type: 'enum',
        options: ['info', 'debug'],
        default: 'info',
        advanced: true,
      },
      { key: 'TELEMETRY', type: 'boolean', default: false, advanced: true },
    ],
  },
  images: [`example/demo:1@sha256:${'a'.repeat(64)}`],
  volumes: ['cache'],
  suggested: { WEB_PORT: 8081, MEDIA_DIR: '/data/srv/demo/media', DATA_DIR: '/data/srv/demo/data' },
  keptSecrets: [],
  status: null,
};

const field = (label: string, help: string) => ({ label, help });
const DEMO_TEXTS = {
  catalog: {
    demo: {
      description: 'A demo service.',
      fields: {
        WEB_PORT: field('Web port', 'Its web page.'),
        MEDIA_DIR: field('Media folder', 'Read only.'),
        DATA_DIR: field('Data folder', 'Its data.'),
        ADMIN_PASSWORD: field('Admin password', 'For signing in.'),
        LOG_LEVEL: field('Log level', 'How much it logs.'),
        TELEMETRY: field('Telemetry', 'Send usage data.'),
      },
    },
  },
};

async function render(entry: CatalogEntryDetails = details, backupsConfigured = false) {
  const api = {
    details: vi.fn(() => of(entry)),
    deploy: vi.fn(() => of({ serviceId: 'x', jobId: 'y' })),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      { provide: ServicesApi, useValue: api },
      { provide: BackupsStore, useValue: { configured: signal(backupsConfigured) } },
      {
        provide: ActivatedRoute,
        useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id: entry.meta.id })) },
      },
    ],
  });
  TestBed.inject(TranslateService).setTranslation('en', DEMO_TEXTS, true);
  const fixture = TestBed.createComponent(InstallPage);
  await fixture.whenStable();
  await vi.waitFor(() => expect(fixture.nativeElement.querySelector('form')).not.toBeNull());
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const input = (id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!;
  const set = async (id: string, value: string) => {
    input(id).value = value;
    input(id).dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  return { fixture, el, api, input, set };
}

describe('InstallPage', () => {
  it('starts from the suggested values, the advanced settings folded away', async () => {
    const { el, input } = await render();
    expect(input('WEB_PORT').value).toBe('8081');
    expect(input('MEDIA_DIR').value).toBe('/data/srv/demo/media');
    expect(input('ADMIN_PASSWORD').type).toBe('password');
    expect(input('ADMIN_PASSWORD').getAttribute('autocomplete')).toBe('new-password');
    expect(el.querySelector('#DB_PASSWORD')).toBeNull(); // generated: never asked
    const advanced = el.querySelector('details')!;
    expect(advanced.open).toBe(false);
    // A themed select (its options drawn by us, never the browser's own white list).
    expect(advanced.querySelector('button#LOG_LEVEL')!.textContent).toContain('info');
    expect(advanced.querySelector<HTMLInputElement>('input#TELEMETRY')!.type).toBe('checkbox');
    // Machine text stays left to right.
    for (const id of ['WEB_PORT', 'MEDIA_DIR', 'ADMIN_PASSWORD'])
      expect(input(id).getAttribute('dir')).toBe('ltr');
  });

  it('shows what the service will be able to do, following the values', async () => {
    const { el, set } = await render();
    const summary = () =>
      el
        .querySelector('section[aria-labelledby="access-title"]')!
        .textContent!.replace(/\s+/g, ' ');
    expect(summary()).toContain('Demo will be able to:');
    expect(summary()).toContain('Use port 8081');
    expect(summary()).toContain('Read /data/srv/demo/media');
    expect(summary()).toContain('Read and change /data/srv/demo/data');
    expect(summary()).toContain('Keep its own data in Docker volumes');
    expect(summary()).toContain('stored encrypted and never shown');
    expect(summary()).toContain(`example/demo:1@sha256:${'a'.repeat(64)}`);
    await set('WEB_PORT', '9000');
    expect(summary()).toContain('Use port 9000');
  });

  it('checks the values before sending anything', async () => {
    const { fixture, api, set } = await render();
    await set('WEB_PORT', '80');
    await set('MEDIA_DIR', 'relative');
    await submit(fixture);
    expect(api.deploy).not.toHaveBeenCalled();
    expect(textOf(fixture)).toContain('A port from 1024 to 65535');
    expect(textOf(fixture)).toContain('A full folder path, like /srv/laris/music');
    expect(textOf(fixture)).toContain('At least 12 characters'); // the empty password
  });

  it('installs with the values, then goes to the services page', async () => {
    const { fixture, api, set } = await render();
    await set('ADMIN_PASSWORD', 'correct horse battery');
    await submit(fixture);
    expect(api.deploy).toHaveBeenCalledWith({
      catalogId: 'demo',
      values: {
        WEB_PORT: 8081,
        MEDIA_DIR: '/data/srv/demo/media',
        DATA_DIR: '/data/srv/demo/data',
        ADMIN_PASSWORD: 'correct horse battery',
        LOG_LEVEL: 'info',
        TELEMETRY: false,
      },
    });
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/services'));
  });

  it('puts the server’s errors on their fields — opening Advanced if one is there', async () => {
    const { fixture, el, api, set } = await render();
    api.deploy.mockReturnValueOnce(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: {
              message: 'Validation failed',
              code: 'invalid_values',
              errors: [
                { field: 'WEB_PORT', code: 'port_in_use', message: 'errors.port_in_use' },
                { field: 'LOG_LEVEL', code: 'invalid_value', message: 'validation.optionInvalid' },
              ],
            },
          }),
      ),
    );
    await set('ADMIN_PASSWORD', 'correct horse battery');
    await submit(fixture);
    const portField = el.querySelector('#WEB_PORT')!.closest('[hlmField]')!;
    expect(portField.textContent).toContain('This port is already in use.');
    expect(el.querySelector('details')!.open).toBe(true);
    expect(el.querySelector('details')!.textContent).toContain('Choose one of the options');
  });

  it('keeps a previous install’s password when left empty', async () => {
    const { fixture, api, input } = await render({
      ...details,
      keptSecrets: ['ADMIN_PASSWORD'],
      status: 'removed',
    });
    expect(input('ADMIN_PASSWORD').placeholder).toBe('Leave empty to keep the current one');
    await submit(fixture);
    expect(api.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ ADMIN_PASSWORD: '' }) }),
    );
  });

  it('says when the entry doesn’t exist', async () => {
    const api = {
      details: vi.fn(() => throwError(() => new HttpErrorResponse({ status: 404 }))),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ServicesApi, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id: 'nope' })) },
        },
      ],
    });
    const fixture = TestBed.createComponent(InstallPage);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(textOf(fixture)).toContain("This service isn't in the catalog.");
    });
  });

  describe('Include in backups', () => {
    const backedUp: CatalogEntryDetails = {
      ...details,
      meta: { ...details.meta, backup: { folders: [{ field: 'DATA_DIR' }], mode: 'stop' } },
    };
    const checkbox = (el: HTMLElement) =>
      [...el.querySelectorAll('label')]
        .find((l) => l.textContent?.includes('Include in backups'))
        ?.querySelector('input');

    it('is offered, ticked, once backups are set up and the recipe can be backed up', async () => {
      const { el, api, fixture, set } = await render(backedUp, true);
      expect(checkbox(el)!.checked).toBe(true);
      await set('ADMIN_PASSWORD', 'correct horse battery');
      await submit(fixture);
      await vi.waitFor(() => expect(api.deploy).toHaveBeenCalled());
      expect(api.deploy).toHaveBeenCalledWith(expect.objectContaining({ includeInBackups: true }));
    });

    it('can be left out', async () => {
      const { el, api, fixture, set } = await render(backedUp, true);
      checkbox(el)!.click();
      await set('ADMIN_PASSWORD', 'correct horse battery');
      await submit(fixture);
      await vi.waitFor(() => expect(api.deploy).toHaveBeenCalled());
      expect(api.deploy).toHaveBeenCalledWith(expect.objectContaining({ includeInBackups: false }));
    });

    it('is not offered before backups are set up, or for a recipe without a backup', async () => {
      expect(checkbox((await render(backedUp, false)).el)).toBeUndefined();
      TestBed.resetTestingModule();
      expect(checkbox((await render(details, true)).el)).toBeUndefined();
    });
  });

  it('takes an option chosen in the select', async () => {
    const { el, api, fixture, set } = await render();
    await set('ADMIN_PASSWORD', 'correct horse battery');
    el.querySelector<HTMLButtonElement>('button#LOG_LEVEL')!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
    const debug = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent?.trim() === 'debug',
    )!;
    debug.click();
    await fixture.whenStable();
    expect(el.querySelector('button#LOG_LEVEL')!.textContent).toContain('debug');
    await submit(fixture);
    await vi.waitFor(() => expect(api.deploy).toHaveBeenCalled());
    expect(api.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ LOG_LEVEL: 'debug' }) }),
    );
  });
});
