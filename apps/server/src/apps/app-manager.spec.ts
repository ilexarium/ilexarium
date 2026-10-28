import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import type { AuditService } from '../audit/audit.service.js';
import type { CatalogService } from '../catalog/catalog.service.js';
import type { DockerService } from '../docker/docker.service.js';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { HelperRequest } from '../linux-sessions/linux-sessions.model.js';
import { AppManager, composeMounts, interpolate } from './app-manager.js';
import { AppTasks } from './app-tasks.js';

const SESSION = 's1';
const ACTOR = { user: { id: 'u1', username: 'owner' }, ip: '127.0.0.1' } as never;

/** ssh2's SFTP calls, done on this machine's files (errors as SFTP's status codes). */
function fakeSftp(): SFTPWrapper {
  const done =
    <T>(cb: (error: Error | null, value?: T) => void) =>
    (error: NodeJS.ErrnoException | null, value?: T) =>
      cb(error ? Object.assign(error, { code: error.code === 'ENOENT' ? 2 : 3 }) : null, value);
  const handles = new Map<string, number>();
  return {
    stat: (path: string, cb: never) => fs.stat(path, done(cb)),
    readdir: (path: string, cb: (e: Error | null, list?: unknown) => void) =>
      fs.readdir(path, (error, names) =>
        done(cb)(
          error,
          names?.map((filename) => ({ filename, attrs: {} })),
        ),
      ),
    open: (path: string, _flags: string, cb: (e: Error | null, h?: Buffer) => void) =>
      fs.open(path, 'r', (error, fd) => {
        const handle = Buffer.from(String(fd));
        if (!error) handles.set(handle.toString(), fd);
        done(cb)(error, handle);
      }),
    read: (
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: never,
    ) => fs.read(handles.get(handle.toString())!, buffer, offset, length, position, done(cb)),
    close: (handle: Buffer, cb: () => void) => fs.close(handles.get(handle.toString())!, cb),
    writeFile: (path: string, data: string, options: { mode: number }, cb: never) =>
      fs.writeFile(path, data, { mode: options.mode }, done(cb)),
    chmod: (path: string, mode: number, cb: never) => fs.chmod(path, mode, done(cb)),
    ext_openssh_rename: (from: string, to: string, cb: never) => fs.rename(from, to, done(cb)),
    rename: (from: string, to: string, cb: never) => fs.rename(from, to, done(cb)),
    unlink: (path: string, cb: never) => fs.unlink(path, done(cb)),
    rmdir: (path: string, cb: never) => fs.rmdir(path, done(cb)),
    mkdir: (path: string, options: { mode: number }, cb: never) =>
      fs.mkdir(path, options, done(cb)),
  } as unknown as SFTPWrapper;
}

let dir: string;
let home: string;
let asked: HelperRequest[];
let taskResult: string | null;
let checkFails: boolean;
let containers: Record<string, unknown>[];

/** The helper as the person: tasks write their record and log as the real one does. */
async function helper(request: HelperRequest) {
  asked.push(request);
  switch (request.action) {
    case 'docker.access':
      return { ok: true, userUnits: true, unitDocker: true, loginDocker: true } as const;
    case 'compose.check':
      return checkFails
        ? ({ ok: false, error: 'compose_invalid', message: 'bad file' } as const)
        : ({ ok: true } as const);
    case 'app.task': {
      const tasks = join(request.folder, '.laris', 'tasks');
      mkdirSync(tasks, { recursive: true });
      const log = `20261028T120000-${request.task}.log`;
      writeFileSync(join(tasks, log), taskResult ?? '');
      const record = {
        unit: `laris-app-${request.project}-${request.task}-20261028T120000`,
        system: request.system,
        action: request.task,
        log,
        startedAt: '2026-10-28T12:00:00.000Z',
      };
      writeFileSync(join(request.folder, '.laris', 'task.json'), JSON.stringify(record));
      return { ok: true, ...record } as const;
    }
    case 'app.taskState':
      return { ok: true, active: 'inactive' } as const;
    case 'paths.size':
      return {
        ok: true,
        sizes: Object.fromEntries(request.paths.map((p) => [p, { bytes: 100, partial: false }])),
      } as const;
    case 'paths.remove':
      for (const path of request.paths) rmSync(path, { recursive: true, force: true });
      return { ok: true } as const;
    case 'volumes.remove':
      return { ok: true } as const;
    default:
      return { ok: false, error: 'bad_request' } as const;
  }
}

function manager(): AppManager {
  const linuxSessions = {
    sftp: () => ({ sftp: fakeSftp(), username: 'anna' }),
    current: () => ({ username: 'anna', home, uid: 1500, sudoUntil: null }),
    account: () => ({ username: 'anna', home, uid: 1500, gid: 1500, sudoUnlocked: false }),
    ask: (_id: string, request: HelperRequest) => helper(request),
  } as unknown as LinuxSessions;
  const docker = { listContainers: async () => containers } as unknown as DockerService;
  const catalog = {
    webPort: () => null,
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
    ],
  },
  compose: `services:\n  web:\n    image: example/web:2\n    ports: ['\${PORT}:80']\n    environment: [ "S=\${NEW_SECRET}" ]\n    volumes: [ "\${MEDIA}:/media" ]\n    labels:\n      laris.template: demo@3\n`,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apps-'));
  home = join(dir, 'home', 'anna');
  mkdirSync(home, { recursive: true });
  asked = [];
  taskResult = null;
  checkFails = false;
  containers = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const install = (env = 'PORT=8080\nMEDIA=/srv/music\n', name = 'music') =>
  manager().install(SESSION, { name, folder: null, template: null, compose, env }, ACTOR);

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
    expect(details.fields.map((f) => [f.key, f.value])).toEqual([
      ['WEB_VERSION', '1.0'],
      ['PORT', '8080'],
      ['MEDIA', '/srv/music'],
    ]);
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
      join(folder, '.laris', 'tasks', '20261028T120000-up.log'),
      'ok\n@@laris-result\nsuccess\n',
    );
    await expect(save(true)).resolves.toMatchObject({ task: { action: 'up' } });
    expect(readFileSync(join(folder, '.env'), 'utf8')).toBe('PORT=1\n');
  });

  it('“Use the current template”: the old file kept beside it, .env kept, new variables added', async () => {
    const folder = join(home, 'apps', 'music');
    await manager().install(
      SESSION,
      {
        name: 'music',
        folder: null,
        template: 'demo',
        compose: `${compose.replace('image: example/web', 'labels:\n      laris.template: demo@1\n    image: example/web')}`,
        env: '# mine\nPORT=8080\nMEDIA=/srv/music\n',
      },
      ACTOR,
    );
    const details = await manager().useTemplate(SESSION, 'music', folder, ACTOR);
    const kept = readdirSync(folder).find((n) => n.startsWith('compose.yml.before-template-'))!;
    expect(kept).toMatch(/^compose\.yml\.before-template-\d{8}$/);
    expect(readFileSync(join(folder, kept), 'utf8')).toContain('demo@1');
    expect(readFileSync(join(folder, 'compose.yml'), 'utf8')).toBe(entry.compose);
    const env = readFileSync(join(folder, '.env'), 'utf8');
    expect(env.startsWith('# mine\nPORT=8080\nMEDIA=/srv/music\n')).toBe(true);
    expect(env).toMatch(/\nNEW_SECRET=[A-Za-z0-9_-]{32}\n$/);
    expect(details.keptFiles).toEqual([kept]);
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
    taskResult = 'removed\n@@laris-result\nsuccess\nexited\n0\n';
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
      { action: 'volumes.remove', names: ['music_cache'], docker: 'direct' },
      { action: 'paths.remove', paths: [folder], administrator: false },
    ]);
  });

  it('only the settings: the files, never the data', async () => {
    await install();
    const folder = join(home, 'apps', 'music');
    taskResult = '@@laris-result\nsuccess\n';
    await manager().remove(SESSION, 'music', folder, ACTOR);
    await manager().delete(
      SESSION,
      'music',
      { folder, settings: true, folders: [], volumes: [] },
      ACTOR,
    );
    expect(existsSync(join(folder, 'compose.yml'))).toBe(false);
    expect(existsSync(join(folder, 'data'))).toBe(true);
  });
});

describe('composeMounts and interpolate', () => {
  it('fills variables as Compose does ($$ a plain $)', () => {
    const values = new Map([['A', 'x']]);
    expect(interpolate('${A}/${B:-d}/$$C/${E}', values)).toBe('x/d/$C/');
  });

  it('bind mounts resolved against the folder; named volumes by their real name, external ones left out', () => {
    expect(
      composeMounts(
        `services:
  a:
    image: x:1
    volumes:
      - ./data:/data
      - \${OUT}:/out
      - type: bind
        source: ../shared
        target: /shared
      - db:/db
      - ext:/ext
      - named:/named
volumes:
  db:
  ext:
    external: true
  named:
    name: \${PREFIX}-named
`,
        'OUT=/mnt/media\nPREFIX=my\n',
        '/home/anna/apps/a',
        'a',
      ),
    ).toEqual({
      folders: ['/home/anna/apps/a/data', '/home/anna/apps/shared', '/mnt/media'],
      volumes: ['a_db', 'my-named'],
    });
  });
});
