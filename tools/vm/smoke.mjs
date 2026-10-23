// The installer's smoke test, run as root inside a freshly installed machine (tools/vm/):
//   node smoke.mjs install   after the first install: setup, sign-in, containers through the proxy
//                            socket, deploying a service, a backup, ending a person's process,
//                            and the security setup (files, sudo, who reaches the proxy)
//   node smoke.mjs update    after running the installer again: everything is still there
// Exits 1 on the first failure. Uses only Node's own modules and the app's `ws`.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const BASE = 'http://127.0.0.1:3000';
const ORIGIN = BASE;
const USER = 'owner';
const PASSWORD = 'correct horse battery staple';
const { default: WebSocket } = await import('/opt/laris/app/node_modules/ws/index.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function done() {
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const fails = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
};

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(cookie && { Cookie: cookie }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-sid='));
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text };
}

async function until(name, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last?.done) return last;
    await sleep(2000);
  }
  check(name, false, `timed out (${JSON.stringify(last?.value ?? last)})`);
  done();
}

/** The first snapshot of a realtime topic. */
function snapshot(topic) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3000/api/ws`, {
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    const timer = setTimeout(
      () => (ws.terminate(), reject(new Error(`no ${topic} snapshot`))),
      20_000,
    );
    ws.on('open', () => ws.send(JSON.stringify({ event: 'subscribe', data: { topic } })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.event === `${topic}:snapshot`) {
        clearTimeout(timer);
        ws.close();
        resolve(message.data);
      }
    });
    ws.on('error', reject);
  });
}

function mode(path) {
  const stat = statSync(path);
  return { mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'), uid: stat.uid, gid: stat.gid };
}
const uidOf = (user) => Number(sh('id', ['-u', user]).trim());
const gidOf = (group) => Number(sh('getent', ['group', group]).split(':')[2]);

async function signIn() {
  const login = await api('POST', '/auth/login', { username: USER, password: PASSWORD });
  check('signs in', login.status === 200, `${login.status} ${login.text}`);
}

async function securitySetup() {
  console.log('\nThe security setup');
  const app = uidOf('laris');
  const appGroup = gidOf('laris');
  const expect = (path, want) => {
    const got = mode(path);
    check(
      `${path}: ${JSON.stringify(want)}`,
      Object.entries(want).every(([k, v]) => got[k] === v),
      JSON.stringify(got),
    );
  };
  expect('/etc/laris/master.key', { mode: '0400', uid: app });
  expect('/etc/laris/app.env', { mode: '0640', uid: 0, gid: appGroup });
  expect('/etc/laris/database.env', { mode: '0600', uid: 0 });
  expect('/etc/laris/wrappers.json', { mode: '0644', uid: 0 });
  expect('/etc/sudoers.d/laris', { mode: '0440', uid: 0 });
  expect('/opt/laris/libexec', { mode: '0755', uid: 0 });
  expect('/opt/laris/libexec/laris-process.mts', { mode: '0755', uid: 0 });
  expect('/var/lib/laris', { mode: '0755', uid: 0 });
  expect('/var/lib/laris/app', { mode: '0700', uid: app });
  expect('/var/lib/laris/backups', { mode: '0750', uid: 0, gid: appGroup });
  expect('/run/laris/proxy', { mode: '0750', uid: 99, gid: appGroup });
  check(
    'the app’s user is not in the docker group',
    !sh('id', ['-nG', 'laris']).split(/\s+/).includes('docker'),
  );
  const appProcess = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'laris']).trim();
  check('the app runs as laris', mode(`/proc/${appProcess}`).uid === app);
  check(
    'the app listens on 127.0.0.1 only',
    !/0\.0\.0\.0:3000|\[::\]:3000|\*:3000/.test(sh('ss', ['-ltnH'])),
  );
  check(
    'Postgres listens on 127.0.0.1 only',
    !/0\.0\.0\.0:5432|\[::\]:5432|\*:5432/.test(sh('ss', ['-ltnH'])),
  );
  check('the proxy has no TCP port', !/:2375\b/.test(sh('ss', ['-ltnH'])));
  // What the app's user may do with sudo: exactly the four wrappers.
  const sudo = sh('sudo', ['-l', '-U', 'laris']);
  const allowed = [...sudo.matchAll(/NOPASSWD:\s*(\S+)/g)].map((m) => m[1]).sort();
  check(
    'sudo: the app may run exactly the four wrappers',
    JSON.stringify(allowed) ===
      JSON.stringify(
        ['backup', 'compose', 'disk', 'process'].map((w) => `/opt/laris/libexec/laris-${w}.mts`),
      ),
    allowed.join(' '),
  );
  check(
    'sudo: not docker',
    fails('runuser', ['-u', 'laris', '--', 'sudo', '-n', '/usr/bin/docker', 'ps']),
  );
  check(
    'the app can’t read the database owner’s password',
    fails('runuser', ['-u', 'laris', '--', 'cat', '/etc/laris/database.env']),
  );
  check(
    'the app can’t open Docker’s socket',
    fails('runuser', [
      '-u',
      'laris',
      '--',
      'curl',
      '-sf',
      '--unix-socket',
      '/var/run/docker.sock',
      'http://d/_ping',
    ]),
  );
  check(
    'the app reaches the proxy’s socket',
    !fails('runuser', [
      '-u',
      'laris',
      '--',
      'curl',
      '-sf',
      '--unix-socket',
      '/run/laris/proxy/docker.sock',
      'http://d/_ping',
    ]),
  );
  ensurePerson();
  check(
    'another user can’t reach the proxy’s socket',
    fails('runuser', [
      '-u',
      'anna',
      '--',
      'curl',
      '-sf',
      '--unix-socket',
      '/run/laris/proxy/docker.sock',
      'http://d/_ping',
    ]),
  );
  check(
    'the proxy still refuses what isn’t allowed',
    sh('runuser', [
      '-u',
      'laris',
      '--',
      'curl',
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--unix-socket',
      '/run/laris/proxy/docker.sock',
      '-X',
      'POST',
      'http://d/containers/create',
    ]).trim() === '403',
  );
  // The database: the app's role may read and write data, nothing more.
  const role = sh('docker', [
    'exec',
    'laris-postgres-1',
    'psql',
    '-tA',
    '-U',
    'laris_owner',
    '-d',
    'laris',
    '-c',
    "SELECT rolsuper, rolcreatedb, rolcreaterole, has_table_privilege('laris', '\"User\"', 'SELECT'), has_table_privilege('laris', '_prisma_migrations', 'SELECT'), has_schema_privilege('laris', 'public', 'CREATE') FROM pg_roles WHERE rolname = 'laris'",
  ]).trim();
  check(
    'the app’s database role reads data, can’t migrate or create',
    role === 'f|f|f|t|f|f',
    role,
  );
}

function ensurePerson() {
  if (fails('id', ['anna'])) {
    sh('useradd', ['--create-home', '--uid', '1500', '--shell', '/bin/bash', 'anna']);
    sh('chpasswd', [], { input: 'anna:anna-smoke-password\n' });
  }
}

/** The Linux sign-in and the file explorer, as anna, through the machine's own sshd. */
async function files() {
  console.log('\nLinux sign-in and files (through this machine’s sshd)');
  ensurePerson();
  const effective = (addr) =>
    sh('sshd', ['-T', '-C', `user=anna,host=client,addr=${addr}`]).match(
      /^passwordauthentication (\w+)/m,
    )?.[1];
  check('sshd: password logins from 127.0.0.1', effective('127.0.0.1') === 'yes');
  check('sshd: password logins from ::1', effective('::1') === 'yes');
  sh('sed', [
    '-i',
    's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/',
    '/etc/ssh/sshd_config',
  ]);
  check(
    'sshd: other addresses keep the main settings (here: no)',
    effective('203.0.113.5') === 'no',
  );
  sh('sed', [
    '-i',
    's/^PasswordAuthentication no$/#PasswordAuthentication yes/',
    '/etc/ssh/sshd_config',
  ]);
  const wrong = await api('POST', '/files/session', { username: 'anna', password: 'wrong' });
  check('a wrong Linux password refused (403, not 401)', wrong.status === 403, `${wrong.status}`);
  const root = await api('POST', '/files/session', { username: 'root', password: 'x' });
  check('root refused', root.status === 403, `${root.status}`);
  const signIn = await api('POST', '/files/session', {
    username: 'anna',
    password: 'anna-smoke-password',
  });
  check(
    'signs in as anna',
    signIn.status === 200 && signIn.json?.home === '/home/anna',
    `${signIn.status} ${signIn.text}`,
  );
  const up = await fetch(`${BASE}/api/files/upload?folder=%2Fhome%2Fanna&name=hello.txt`, {
    method: 'PUT',
    headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/octet-stream' },
    body: 'hello from the smoke test',
  });
  check('uploads into her home', up.status === 204, `${up.status}`);
  check('the file belongs to anna', mode('/home/anna/hello.txt').uid === uidOf('anna'));
  const list = await api('GET', '/files/list?path=%2Fhome%2Fanna');
  check(
    'lists her home',
    list.json?.entries?.some((e) => e.name === 'hello.txt'),
    list.text.slice(0, 200),
  );
  const root2 = await api('GET', '/files/list?path=%2Froot');
  check('/root refused (Linux decides)', root2.status === 403, `${root2.status}`);
  const del = await api('DELETE', '/files?path=%2Fhome%2Fanna%2Fhello.txt');
  check('deletes it', del.status === 204 && !existsSync('/home/anna/hello.txt'), `${del.status}`);
  await terminal();
  await api('DELETE', '/files/session');
}

/**
 * The profile as the installed app keeps it: a name, then a picture in its own table (the app's
 * restricted database role must be able to write and read it). The picture is only a WebP
 * header of 600×600 — what the server checks; it never decodes the image.
 */
async function profile() {
  const saved = await api('PATCH', '/profile', { displayName: 'Smoke Test' });
  check(
    'profile: a display name saved',
    saved.json?.user?.displayName === 'Smoke Test',
    saved.text,
  );
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(22, 4);
  header.write('WEBPVP8X', 8, 'latin1');
  header.writeUInt32LE(10, 16);
  header.writeUIntLE(599, 24, 3);
  header.writeUIntLE(599, 27, 3);
  const put = await fetch(`${BASE}/api/profile/avatar`, {
    method: 'PUT',
    headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'image/webp' },
    body: header,
  });
  check('profile: a picture kept', put.status === 200, `${put.status}`);
  const got = await fetch(`${BASE}/api/profile/avatar`, { headers: { Cookie: cookie } });
  check(
    'profile: the picture served as an image only',
    got.status === 200 &&
      got.headers.get('content-type') === 'image/webp' &&
      got.headers.get('x-content-type-options') === 'nosniff',
    `${got.status} ${got.headers.get('content-type')}`,
  );
  const removed = await api('DELETE', '/profile/avatar');
  check('profile: the picture removed', removed.json?.user?.avatar === null, removed.text);
}

/** The web terminal: a shell as anna through this machine's sshd (the Linux session is open). */
async function terminal() {
  const ticket = await api('POST', '/terminal/ticket', { password: PASSWORD });
  check('terminal: a ticket with the app password', ticket.status === 200, `${ticket.status}`);
  const result = await new Promise((resolve) => {
    let output = '';
    const ws = new WebSocket(
      `ws://127.0.0.1:3000/api/terminal?ticket=${ticket.json?.ticket}&cols=80&rows=24`,
      { headers: { Cookie: cookie, Origin: ORIGIN } },
    );
    const timer = setTimeout(() => (ws.terminate(), resolve({ output, code: 'timeout' })), 20_000);
    ws.on('message', (data) => {
      output += data.toString();
      if (/\$ ?$/m.test(output) && !output.includes('who=')) {
        ws.send(Buffer.from('echo "who=$(id -un)"; exit\n'), { binary: true });
      }
    });
    ws.on('close', (code) => (clearTimeout(timer), resolve({ output, code })));
    ws.on('error', () => undefined);
  });
  check('terminal: a shell as anna', /who=anna/.test(result.output), result.output.slice(-200));
  check('terminal: exit closes it (4000)', result.code === 4000, `${result.code}`);
}

async function install() {
  console.log('First install');
  check('the app answers', (await api('GET', '/health')).status === 200);
  const status = await api('GET', '/auth/status');
  check('needs setup', status.json?.needsSetup === true, status.text);
  const token = readFileSync('/var/lib/laris/app/setup-token', 'utf8').trim();
  const setup = await api('POST', '/auth/setup', {
    setupToken: token,
    username: USER,
    password: PASSWORD,
  });
  check(
    'setup with the code from the token file',
    setup.status === 200 || setup.status === 201,
    `${setup.status} ${setup.text}`,
  );
  await signIn();
  check(
    'the web app is served on the same origin',
    (await fetch(`${BASE}/backups`).then((r) => r.text())).includes('<laris-root'),
  );

  await securitySetup();

  console.log('\nContainers through the proxy');
  const containers = await snapshot('containers');
  const names = (containers.containers ?? []).map((c) => c.name);
  check(
    'Docker reachable through the proxy socket',
    containers.dockerAvailable === true,
    JSON.stringify(containers).slice(0, 200),
  );
  check(
    'the platform’s containers, protected',
    ['laris-postgres-1', 'laris-docker-proxy-1'].every(
      (n) => containers.containers?.find((c) => c.name === n)?.protected,
    ),
    names.join(', '),
  );

  console.log('\nDeploying a service');
  mkdirSync('/srv/laris/navidrome/music', { recursive: true });
  const deploy = await api('POST', '/services', {
    catalogId: 'navidrome',
    values: {
      WEB_PORT: 4533,
      MUSIC_DIR: '/srv/laris/navidrome/music',
      DATA_DIR: '/srv/laris/navidrome/data',
    },
  });
  check(
    'deploy started',
    deploy.status === 202 || deploy.status === 201,
    `${deploy.status} ${deploy.text}`,
  );
  const job = await until(
    'Navidrome installed',
    async () => {
      const j = await api('GET', `/services/jobs/${deploy.json?.jobId}`);
      return { done: j.json?.status && j.json.status !== 'running', value: j.json };
    },
    15 * 60_000,
  );
  check('Navidrome installed', job.value.status === 'succeeded', jobSummary(job.value));

  // Ollama: its API published on loopback only (docs/plans/ai_assistant.md) — the root wrapper
  // accepts host_ip 127.0.0.1 and nothing else; nothing on the network may reach it.
  console.log('\nInstalling Ollama (the Assistant)');
  const ollama = await api('POST', '/services', {
    catalogId: 'ollama',
    values: { API_PORT: 11434, MODELS_DIR: '/srv/laris/ollama/models' },
  });
  check('Ollama deploy started', ollama.status === 202 || ollama.status === 201, ollama.text);
  const ollamaJob = await until(
    'Ollama installed',
    async () => {
      const j = await api('GET', `/services/jobs/${ollama.json?.jobId}`);
      return { done: j.json?.status && j.json.status !== 'running', value: j.json };
    },
    20 * 60_000,
  );
  check('Ollama installed', ollamaJob.value.status === 'succeeded', jobSummary(ollamaJob.value));
  // Reached from the machine itself, refused on its network address.
  const answers = async (host) => {
    try {
      return (
        await fetch(`http://${host}:11434/api/version`, { signal: AbortSignal.timeout(5000) })
      ).ok;
    } catch {
      return false;
    }
  };
  const networkAddress = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  check('Ollama answers on 127.0.0.1', await answers('127.0.0.1'));
  check(
    `Ollama is not reachable on the network address (${networkAddress})`,
    networkAddress !== undefined && !(await answers(networkAddress)),
  );
  const assistant = await until(
    'the Assistant finds Ollama',
    async () => {
      const s = await api('GET', '/assistant/status');
      return { done: s.json?.state === 'ready', value: s.json };
    },
    2 * 60_000,
  );
  check(
    'the Assistant finds Ollama',
    assistant.value?.state === 'ready',
    JSON.stringify(assistant.value),
  );

  console.log('\nBacking up');
  const plan = await api('POST', '/backups/plan', {
    destination: '/mnt/backup',
    schedule: { frequency: 'daily', time: '03:00' },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    items: [{ kind: 'service', serviceId: deploy.json?.serviceId }],
  });
  check(
    'backups set up',
    plan.status === 200 || plan.status === 201,
    `${plan.status} ${plan.text}`,
  );
  check('the passphrase shown once', typeof plan.json?.passphrase === 'string');
  const run = await api('POST', '/backups/runs', {});
  check('"Back up now" started', run.status === 202, `${run.status} ${run.text}`);
  const result = await until(
    'the backup finished',
    async () => {
      const s = await api('GET', '/backups/status');
      return { done: s.json?.lastRun && !s.json.running, value: s.json?.lastRun };
    },
    15 * 60_000,
  );
  check(
    'the backup succeeded',
    ['ok', 'warning'].includes(result.value?.status),
    JSON.stringify(result.value).slice(0, 400),
  );

  console.log('\nEnding a person’s process (as that person, through sudo)');
  ensurePerson();
  const child = spawn(
    'setpriv',
    ['--reuid=anna', '--regid=anna', '--clear-groups', 'sleep', '300'],
    { stdio: 'ignore' },
  );
  await sleep(500);
  const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  const startTicks = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)[19];
  const exited = new Promise((r) => child.on('exit', (_, signal) => r(signal)));
  const end = await api('POST', '/processes/signal', {
    pid: child.pid,
    startTicks,
    signal: 'TERM',
  });
  check('ended through the wrapper', end.status === 204, `${end.status} ${end.text}`);
  check(
    'it got SIGTERM',
    (await Promise.race([exited, sleep(5000).then(() => 'still running')])) === 'SIGTERM',
  );
  const init = await api('POST', '/processes/signal', { pid: 1, startTicks: '1', signal: 'KILL' });
  check('PID 1 refused', init.status === 403 || init.status === 404, `${init.status}`);
  await files();
  await profile();
  done();
}

async function update() {
  console.log('After running the installer again');
  check('the app answers', (await api('GET', '/health')).status === 200);
  check('still set up', (await api('GET', '/auth/status')).json?.needsSetup === false);
  await signIn();
  const services = await api('GET', '/services');
  check(
    'Navidrome still installed',
    services.json?.services?.some((s) => s.catalogId === 'navidrome' && s.status === 'installed'),
    services.text.slice(0, 300),
  );
  check(
    'the chat tables migrated (the Assistant answers)',
    (await api('GET', '/assistant/chats')).status === 200,
  );
  check('backups still set up', (await api('GET', '/backups/status')).json?.configured === true);
  check(
    'a database backup was made before migrating',
    sh('ls', ['/var/lib/laris/install-backups']).trim().length > 0,
  );
  check('the version recorded', existsSync('/etc/laris/version'));
  await securitySetup();
  await files();
  await profile();
  done();
}

await (process.argv[2] === 'update' ? update() : install());

/** A failed job, readably: its status and error, then the end of its output (where the reason is). */
function jobSummary(job) {
  if (!job) return 'no job';
  const tail = (job.output ?? []).slice(-15).join('\n    ');
  return `${job.status} ${job.errorCode ?? ''} ${job.errorField ?? ''}\n    … ${tail}`;
}
