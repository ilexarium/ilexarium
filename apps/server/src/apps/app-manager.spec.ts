import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from '@ilex/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { DockerService } from '../docker/docker.service.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { HelperRequest } from '../linux-sessions/linux-sessions.model.js';
import { Sftp } from '../linux-sessions/sftp.js';
import { fakeSftp } from '../linux-sessions/testing.js';
import { AppManager } from './app-manager.js';
import { AppTasks } from './app-tasks.js';

const SESSION = 's1';
const ACTOR = { user: { id: 'u1', username: 'owner' }, ip: '127.0.0.1' } as never;

let dir: string;
let home: string;
let asked: HelperRequest[];
let taskResult: string | null;
let checkFails: boolean;
/** Not in the docker group, sudo locked: a task would need the account's sudo. */
let withoutDocker: boolean;
let taskActive: string;
/** A container's files (not the account's): deleting them needs sudo, locked until set. */
let foreign: string | null;
let sudoLocked: boolean;
let containers: Record<string, unknown>[];
/** More folders Compose would say the file mounts (`~`). */
let homeMounts: string[];
/** Runs right after a deletion as the account: something written into the folder meanwhile. */
let meanwhile: (() => void) | null;

/** The helper as the person: tasks write their record and log as the real one does. */
async function helper(request: HelperRequest) {
  asked.push(request);
  switch (request.action) {
    case 'docker.access':
      return {
        ok: true,
        userUnits: true,
        unitDocker: !withoutDocker,
        loginDocker: !withoutDocker,
      } as const;
    case 'compose.check': {
      if (checkFails) return { ok: false, error: 'compose_invalid', message: 'bad file' } as const;
      // What Compose says of the file below: its folders resolved, its volume by Docker's name.
      // Another file (a project made elsewhere) mounts nothing.
      const { folder, project } = request;
      const read = (name: string) =>
        existsSync(join(folder, name)) ? readFileSync(join(folder, name), 'utf8') : '';
      const env = parseEnv(read('.env'));
      const file = read('compose.yml') || read('docker-compose.yml');
      const label = /ilex\.template: (\S+)/.exec(file);
      const known = file.includes('./data');
      return {
        ok: true,
        mounts: [
          ...(known
            ? [
                { type: 'bind', source: join(folder, 'data') },
                { type: 'bind', source: resolve(folder, env.get('MEDIA') ?? '') },
                { type: 'volume', source: 'cache' },
                { type: 'volume', source: null },
                { type: 'bind', source: '/var/run/docker.sock' },
              ]
            : []),
          ...homeMounts.map((source) => ({ type: 'bind', source })),
        ],
        volumes: known ? [{ key: 'cache', name: `${project}_cache`, external: false }] : [],
        templates: label ? [label[1]] : [],
      } as const;
    }
    case 'app.task': {
      const tasks = join(request.folder, '.ilex', 'tasks');
      mkdirSync(tasks, { recursive: true });
      const log = `20261028T120000-${request.task}.log`;
      writeFileSync(join(tasks, log), taskResult ?? '');
      const record = {
        unit: `ilex-app-${request.project}-${request.task}-20261028T120000`,
        system: request.system,
        action: request.task,
        log,
        startedAt: '2026-10-28T12:00:00.000Z',
      };
      writeFileSync(join(request.folder, '.ilex', 'task.json'), JSON.stringify(record));
      return { ok: true, ...record } as const;
    }
    case 'app.taskState':
      return { ok: true, active: taskActive } as const;
    case 'paths.size':
      return {
        ok: true,
        sizes: Object.fromEntries(request.paths.map((p) => [p, { bytes: 100, partial: false }])),
      } as const;
    case 'paths.remove': {
      const needsSudo = foreign !== null && request.paths.some((p) => foreign!.startsWith(p));
      if (needsSudo && !request.administrator) {
        // `rm -r -f` deletes what it can, then fails on the rest.
        for (const path of request.paths)
          if (path !== foreign) rmSync(path, { recursive: true, force: true });
        return { ok: false, error: 'not_permitted' } as const;
      }
      if (needsSudo && sudoLocked) return { ok: false, error: 'sudo_required' } as const;
      for (const path of request.paths) rmSync(path, { recursive: true, force: true });
      meanwhile?.();
      return { ok: true } as const;
    }
    case 'volumes.remove':
      return { ok: true } as const;
    default:
      return { ok: false, error: 'bad_request' } as const;
  }
}

function manager(): AppManager {
  const linuxSessions = {
    sftp: () => ({ sftp: new Sftp(fakeSftp()), username: 'anna' }),
    current: () => ({ username: 'anna', home, uid: 1500, sudoUntil: null }),
    account: () => ({ username: 'anna', home, uid: 1500, gid: 1500, sudoUnlocked: false }),
    ask: (_id: string, request: HelperRequest) => helper(request),
  } as unknown as LinuxSessions;
  const docker = { listContainers: async () => containers } as unknown as DockerService;
  const catalog = {
    webPage: () => null,
    get: (id: string) => (id === 'demo' ? entry : undefined),
    require: (id: string) => {
      if (id !== 'demo') throw new Error('no such template');
      return entry;
    },
  } as unknown as CatalogService;
  const audit = { record: vi.fn(async () => undefined), tryRecord: vi.fn(async () => undefined) };
  const tasks = new AppTasks(linuxSessions, new ChangesUnderway());
  return new AppManager(docker, catalog, linuxSessions, tasks, audit as unknown as AuditService);
}

const compose = `services:
  web:
    image: example/web:\${WEB_VERSION:-1.0}
    ports: ['\${PORT}:80']
    volumes:
      - ./data:/data
      - \${MEDIA}:/media:ro
      - cache:/cache
      - /var/lib/cache
      - /var/run/docker.sock:/var/run/docker.sock
volumes:
  cache:
`;

const entry = {
  template: {
    id: 'demo',
    version: '3',
    fields: [
      { key: 'PORT', kind: 'port', default: 8080 },
      { key: 'MEDIA', kind: 'folder', default: './media' },
      { key: 'NEW_SECRET', kind: 'generated' },
      { key: 'USER_ID', kind: 'text', default: '@account', advanced: true },
    ],
  },
  compose: `services:\n  web:\n    image: example/web:2\n    ports: ['\${PORT}:80']\n    environment: [ "S=\${NEW_SECRET}" ]\n    volumes: [ "\${MEDIA}:/media" ]\n    labels:\n      ilex.template: demo@3\n`,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apps-'));
  home = join(dir, 'home', 'anna');
  mkdirSync(home, { recursive: true });
  asked = [];
  taskResult = null;
  checkFails = false;
  withoutDocker = false;
  taskActive = 'inactive';
  foreign = null;
  sudoLocked = false;
  containers = [];
  homeMounts = [];
  meanwhile = null;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const install = (env = 'PORT=8080\nMEDIA=/srv/music\n', name = 'music', file = compose) =>
  manager().install(SESSION, { name, folder: null, template: null, compose: file, env }, ACTOR);

describe('AppManager.install', () => {
  it('writes the files as the person (.env private), makes the data folders, checks, then starts', async () => {
    const started = await install('PORT=8080\nMEDIA=./media\n');
    const folder = join(home, 'apps', 'music');
    expect(started).toMatchObject({
      name: 'music',
      folder,
      task: { action: 'up', state: 'running' },
    });
    expect(readFileSync(join(folder, 'compose.yml'), 'utf8')).toBe(compose);
    expect(statSync(join(folder, '.env')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(folder, 'data'))).toBe(true);
    expect(existsSync(join(folder, 'media'))).toBe(true);
    expect(asked.map((a) => a.action)).toEqual(['docker.access', 'compose.check', 'app.task']);
  });

  it('a template’s account field left empty (the form came before the sign-in): this account', async () => {
    await manager().install(
      SESSION,
      { name: 'music', folder: null, template: 'demo', compose, env: 'PORT=8080\nUSER_ID=\n' },
      ACTOR,
    );
    expect(readFileSync(join(home, 'apps', 'music', '.env'), 'utf8')).toBe(
      'PORT=8080\nUSER_ID=1500:1500\n',
    );
  });

  it('refuses a name Docker knows, and a folder that isn’t empty', async () => {
    containers = [{ name: 'x', composeProject: 'music', state: 'running', ports: [] }];
    await expect(install()).rejects.toMatchObject({ response: { code: 'app_name_taken' } });
    containers = [];
    mkdirSync(join(dir, 'busy'));
    writeFileSync(join(dir, 'busy', 'x'), '');
    await expect(
      manager().install(
        SESSION,
        { name: 'other', folder: join(dir, 'busy'), template: null, compose, env: '' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: 'app_folder_exists' } });
  });

  it('leaves nothing behind when Compose refuses the files', async () => {
    checkFails = true;
    await expect(install()).rejects.toMatchObject({
      response: { code: 'compose_invalid', detail: 'bad file' },
    });
    expect(existsSync(join(home, 'apps'))).toBe(false);
  });
});

describe('AppManager: reading and saving', () => {
  it('reads the files fresh; a save with files changed on disk meanwhile is refused, overwrite allowed', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    const details = await manager().details(SESSION, 'music', folder);
    expect(details.compose).toBe(compose);
    // No template: the files alone.
    expect(details).toMatchObject({ fields: [], template: null });
    writeFileSync(join(folder, '.env'), 'PORT=9000\n');
    const save = (overwrite: boolean) =>
      manager().save(
        SESSION,
        'music',
        { folder, compose, env: 'PORT=1\n', hash: details.hash, overwrite },
        ACTOR,
      );
    await expect(save(false)).rejects.toMatchObject({ response: { code: 'changed_on_disk' } });
    // The task before succeeded: a new one may start.
    writeFileSync(
      join(folder, '.ilex', 'tasks', '20261028T120000-up.log'),
      'ok\n@@ilex-result\nsuccess\n',
    );
    await expect(save(true)).resolves.toMatchObject({ task: { action: 'up' } });
    expect(readFileSync(join(folder, '.env'), 'utf8')).toBe('PORT=1\n');
  });
});

describe('AppManager: a change that doesn’t start changes nothing', () => {
  const folder = () => join(home, 'apps', 'music');
  const finished = () =>
    writeFileSync(
      join(folder(), '.ilex', 'tasks', '20261028T120000-up.log'),
      'ok\n@@ilex-result\nsuccess\n',
    );

  it('a save Compose refuses: the files as they were, so trying again isn’t “changed on disk”', async () => {
    await install();
    finished();
    const details = await manager().details(SESSION, 'music', folder());
    checkFails = true;
    const request = {
      folder: folder(),
      compose: 'services: {}\n',
      env: 'PORT=1\n',
      hash: details.hash,
      overwrite: false,
    };
    await expect(manager().save(SESSION, 'music', request, ACTOR)).rejects.toMatchObject({
      response: { code: 'compose_invalid' },
    });
    expect(readFileSync(join(folder(), 'compose.yml'), 'utf8')).toBe(compose);
    expect(readFileSync(join(folder(), '.env'), 'utf8')).toBe('PORT=8080\nMEDIA=/srv/music\n');
    checkFails = false;
    await expect(manager().save(SESSION, 'music', request, ACTOR)).resolves.toMatchObject({
      task: { action: 'up' },
    });
  });

  it('sudo locked and needed: asked before anything is written', async () => {
    await install();
    finished();
    const details = await manager().details(SESSION, 'music', folder());
    withoutDocker = true;
    const request = {
      folder: folder(),
      compose: 'services: {}\n',
      env: '',
      hash: details.hash,
      overwrite: false,
    };
    await expect(manager().save(SESSION, 'music', request, ACTOR)).rejects.toMatchObject({
      response: { code: 'sudo_required' },
    });
    expect(readFileSync(join(folder(), 'compose.yml'), 'utf8')).toBe(compose);
  });

  it('an update while a task runs: refused; after it: pull and up, nothing saved beside', async () => {
    await install();
    taskActive = 'active';
    await expect(manager().update(SESSION, 'music', folder(), ACTOR)).rejects.toMatchObject({
      response: { code: 'app_task_running' },
    });
    taskActive = 'inactive';
    finished();
    await expect(manager().update(SESSION, 'music', folder(), ACTOR)).resolves.toMatchObject({
      task: { action: 'update' },
    });
    expect(readdirSync(join(folder(), '.ilex')).sort()).toEqual(['task.json', 'tasks']);
  });

  it('start, for an app without containers: refused while a task runs; after it, up', async () => {
    await install();
    taskActive = 'active';
    await expect(manager().start(SESSION, 'music', folder(), ACTOR)).rejects.toMatchObject({
      response: { code: 'app_task_running' },
    });
    taskActive = 'inactive';
    finished();
    await expect(manager().start(SESSION, 'music', folder(), ACTOR)).resolves.toMatchObject({
      task: { action: 'up' },
    });
  });

  it('an app Docker runs: never acted on in another folder than Docker’s (a link’s ?folder=)', async () => {
    await install();
    finished();
    containers = [
      {
        name: 'music-web-1',
        composeProject: 'music',
        composeWorkingDir: folder(),
        state: 'running',
        ports: [],
      },
    ];
    const elsewhere = join(dir, 'theirs');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'compose.yml'), compose);
    const mismatch = { response: { code: 'app_folder_mismatch' } };
    const m = manager();
    const before = asked.length;
    await expect(m.update(SESSION, 'music', elsewhere, ACTOR)).rejects.toMatchObject(mismatch);
    await expect(m.apply(SESSION, 'music', elsewhere, ACTOR)).rejects.toMatchObject(mismatch);
    await expect(m.removal(SESSION, 'music', elsewhere)).rejects.toMatchObject(mismatch);
    await expect(m.remove(SESSION, 'music', elsewhere, ACTOR)).rejects.toMatchObject(mismatch);
    await expect(
      m.save(
        SESSION,
        'music',
        { folder: elsewhere, compose, env: '', hash: 'x', overwrite: true },
        ACTOR,
      ),
    ).rejects.toMatchObject(mismatch);
    await expect(
      m.delete(SESSION, 'music', { folder: elsewhere, folders: [], volumes: [] }, ACTOR),
    ).rejects.toMatchObject(mismatch);
    expect(asked.slice(before)).toEqual([]);
    // Its own folder: as before.
    await expect(m.update(SESSION, 'music', folder(), ACTOR)).resolves.toMatchObject({
      task: { action: 'update' },
    });
  });

  it('Docker not answering: an action is refused, never taken for an app Docker doesn’t know', async () => {
    await install();
    finished();
    const m = manager();
    (m as unknown as { dockerService: { listContainers: () => Promise<never> } }).dockerService = {
      listContainers: () => Promise.reject(new Error('proxy down')),
    };
    await expect(m.update(SESSION, 'music', folder(), ACTOR)).rejects.toMatchObject({
      response: { code: 'docker_unavailable' },
    });
  });

  it('the helper’s “others could change this folder”: its own error, with the path', async () => {
    await install();
    finished();
    const original = helper;
    checkFails = false;
    const m = manager();
    const linux = (m as unknown as { linuxSessions: { ask: unknown } }).linuxSessions;
    linux.ask = async (_id: string, request: HelperRequest) =>
      request.action === 'compose.check'
        ? { ok: false, error: 'folder_unsafe', message: folder() }
        : original(request);
    await expect(m.update(SESSION, 'music', folder(), ACTOR)).rejects.toMatchObject({
      status: 403,
      response: { code: 'app_folder_unsafe', detail: folder() },
    });
  });

  it('apply (after a restore): its files as they are, brought up', async () => {
    await install();
    taskActive = 'inactive';
    finished();
    await expect(manager().apply(SESSION, 'music', folder(), ACTOR)).resolves.toMatchObject({
      task: { action: 'up' },
    });
  });
});

describe('AppManager: removing', () => {
  it('lists the settings, each data folder (one outside marked) and each named volume, nothing ticked', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    const { items } = await manager().removal(SESSION, 'music', folder);
    expect(items).toEqual([
      { kind: 'settings', path: folder, bytes: null, outside: false },
      { kind: 'folder', path: join(folder, 'data'), bytes: 100, outside: false },
      { kind: 'folder', path: '/srv/music', bytes: 100, outside: true },
      { kind: 'volume', path: 'music_cache', bytes: null, outside: false },
    ]);
  });

  it('deletes only after its down succeeded, only what the removal listed; all inside ticked: the whole folder', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    const request = {
      folder,
      settings: true,
      folders: [join(folder, 'data')],
      volumes: ['music_cache', 'other'],
    };
    await expect(manager().delete(SESSION, 'music', request, ACTOR)).rejects.toMatchObject({
      response: { code: 'app_task_running' },
    });
    taskResult = 'removed\n@@ilex-result\nsuccess\nexited\n0\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    await manager().delete(
      SESSION,
      'music',
      { ...request, folders: [...request.folders, '/etc'] },
      ACTOR,
    );
    expect(existsSync(folder)).toBe(false);
    const removals = asked.filter(
      (a) => a.action === 'paths.remove' || a.action === 'volumes.remove',
    );
    expect(removals).toEqual([
      { action: 'paths.remove', paths: [join(folder, 'data')], administrator: false },
      { action: 'volumes.remove', names: ['music_cache'], docker: 'direct' },
      {
        action: 'paths.remove',
        paths: [join(folder, 'compose.yml'), join(folder, '.env'), join(folder, '.ilex')],
        administrator: false,
      },
    ]);
  });

  it('a container’s files need sudo, locked: the app’s files stay, so the retry after unlocking works', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    taskResult = '@@ilex-result\nsuccess\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    foreign = join(folder, 'data');
    sudoLocked = true;
    const request = {
      folder,
      settings: true,
      folders: [join(folder, 'data')],
      volumes: ['music_cache'],
    };
    await expect(manager().delete(SESSION, 'music', request, ACTOR)).rejects.toMatchObject({
      response: { code: 'sudo_required' },
    });
    expect(existsSync(join(folder, 'compose.yml'))).toBe(true);
    // The volumes come after the folders: none deleted yet, so the retry doesn't find them gone.
    expect(asked.filter((a) => a.action === 'volumes.remove')).toEqual([]);
    sudoLocked = false;
    await manager().delete(SESSION, 'music', request, ACTOR);
    expect(existsSync(folder)).toBe(false);
    expect(asked.filter((a) => a.action === 'volumes.remove')).toHaveLength(1);
  });

  it('only the settings: the files, never the data; the folder stays with it', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    taskResult = '@@ilex-result\nsuccess\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    await manager().delete(
      SESSION,
      'music',
      { folder, settings: true, folders: [], volumes: [] },
      ACTOR,
    );
    expect(readdirSync(folder)).toEqual(['data']);
  });

  it('other files beside the settings: only what was ticked goes, the folder stays with the rest', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    writeFileSync(join(folder, 'Dockerfile'), 'FROM scratch\n');
    mkdirSync(join(folder, '.git'));
    writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    taskResult = '@@ilex-result\nsuccess\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    await manager().delete(
      SESSION,
      'music',
      { folder, settings: true, folders: [join(folder, 'data')], volumes: [] },
      ACTOR,
    );
    expect(readdirSync(folder).sort()).toEqual(['.git', 'Dockerfile']);
    expect(readFileSync(join(folder, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
  });

  it('a data folder below another folder: the emptied folders between go too, so the app’s folder does', async () => {
    await install('PORT=8080\nMEDIA=./media/music\n');
    const folder = join(home, 'apps', 'music');
    taskResult = '@@ilex-result\nsuccess\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    await manager().delete(
      SESSION,
      'music',
      {
        folder,
        settings: true,
        folders: [join(folder, 'data'), join(folder, 'media', 'music')],
        volumes: [],
      },
      ACTOR,
    );
    expect(existsSync(folder)).toBe(false);
  });

  it('a data folder below another one left unticked: that one stays, also when it is empty', async () => {
    const folder = join(home, 'apps', 'music');
    homeMounts = [join(folder, 'media')];
    await install('PORT=8080\nMEDIA=./media/music\n');
    taskResult = '@@ilex-result\nsuccess\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    await manager().delete(
      SESSION,
      'music',
      {
        folder,
        settings: true,
        folders: [join(folder, 'data'), join(folder, 'media', 'music')],
        volumes: [],
      },
      ACTOR,
    );
    expect(readdirSync(folder)).toEqual(['media']);
    expect(readdirSync(join(folder, 'media'))).toEqual([]);
  });

  it('a file written into the folder while it is deleted stays, and the folder with it', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    taskResult = '@@ilex-result\nsuccess\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    meanwhile = () => writeFileSync(join(folder, 'late.txt'), 'new\n');
    await manager().delete(
      SESSION,
      'music',
      { folder, settings: true, folders: [join(folder, 'data')], volumes: [] },
      ACTOR,
    );
    expect(readdirSync(folder)).toEqual(['late.txt']);
  });
});

describe('AppManager: removing a Compose project made outside Ilexarium', () => {
  /** Its folder with these files (a link: `-> target`), its `down` done. */
  async function removed(files: Record<string, string>): Promise<string> {
    const folder = join(home, 'src', 'myapp');
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      if (content.startsWith('-> ')) symlinkSync(content.slice(3), join(folder, name));
      else writeFileSync(join(folder, name), content);
    }
    taskResult = '@@ilex-result\nsuccess\n';
    await manager().remove(SESSION, 'myapp', folder, ACTOR);
    return folder;
  }
  const deleteSettings = (folder: string) =>
    manager().delete(SESSION, 'myapp', { folder, settings: true, folders: [], volumes: [] }, ACTOR);

  it('nothing mounted inside, its source beside it: only its Compose file and .ilex go', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'kept.txt'), 'kept\n');
    const folder = await removed({
      'docker-compose.yml': 'services:\n  web:\n    build: .\n',
      Dockerfile: 'FROM scratch\n',
      'src/main.go': 'package main\n',
      shared: `-> ${elsewhere}`,
    });
    const { items } = await manager().removal(SESSION, 'myapp', folder);
    expect(items).toEqual([{ kind: 'settings', path: folder, bytes: null, outside: false }]);
    await deleteSettings(folder);
    expect(readdirSync(folder).sort()).toEqual(['Dockerfile', 'shared', 'src']);
    expect(readFileSync(join(folder, 'src', 'main.go'), 'utf8')).toBe('package main\n');
    expect(readFileSync(join(elsewhere, 'kept.txt'), 'utf8')).toBe('kept\n');
  });

  it('its settings alone in the folder (no .env): the folder goes', async () => {
    const folder = await removed({ 'docker-compose.yml': 'services:\n  web:\n    image: x\n' });
    await deleteSettings(folder);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(join(home, 'src'))).toBe(true);
  });
});

describe('AppManager.details of a template’s app that doesn’t run', () => {
  it('its label from Compose’s answer; its form from the template, values from .env', async () => {
    await install(
      'PORT=9000\nMEDIA=./media\n',
      'music',
      compose.replace('    ports:', '    labels: { ilex.template: demo@3 }\n    ports:'),
    );
    const details = await manager().details(SESSION, 'music', join(home, 'apps', 'music'));
    expect(details.template).toEqual({ id: 'demo', version: '3' });
    expect(details.fields.map((f) => [f.key, f.value])).toEqual([
      ['PORT', '9000'],
      ['MEDIA', './media'],
      ['NEW_SECRET', expect.stringMatching(/^[\w-]{32}$/)],
      ['USER_ID', '1500:1500'],
    ]);
  });

  it('files Compose refuses: no label, no form — the editors still open', async () => {
    await install();
    checkFails = true;
    const details = await manager().details(SESSION, 'music', join(home, 'apps', 'music'));
    expect(details).toMatchObject({ template: null, fields: [] });
  });
});

describe('AppManager.removal: never the home', () => {
  it('a mount of the home itself (Compose’s `~`) or a folder above it is never offered', async () => {
    await install();
    homeMounts = [home, join(dir, 'home')];
    const { items } = await manager().removal(SESSION, 'music', join(home, 'apps', 'music'));
    expect(items.map((i) => i.path)).not.toContain(home);
    expect(items.map((i) => i.path)).not.toContain(join(dir, 'home'));
  });
});

describe('AppManager.removal', () => {
  it('a file Compose refuses (a required variable missing): Compose’s error, not an empty list', async () => {
    await install();
    checkFails = true;
    await expect(
      manager().removal(SESSION, 'music', join(home, 'apps', 'music')),
    ).rejects.toMatchObject({ response: { code: 'compose_invalid', detail: 'bad file' } });
  });
});
