// The installer's smoke test, run as root inside a freshly installed machine (tools/vm/):
//   node smoke.mjs install   after the first install: setup, sign-in, containers through the proxy
//                            socket, ending processes as a person, apps installed as a person
//                            (through her sudo; with the docker group as user units), a backup,
//                            a restore to a new folder and one back where it was (the app brought
//                            up with the restored settings) through her sudo, and the security
//                            setup (files, no sudo for the app, who reaches the proxy), and
//                            freeing Docker's unused data
//   node smoke.mjs update    after running the installer again: everything is still there
// Exits 1 on the first failure. Uses only Node's own modules and the app's `ws`.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  expect('/opt/laris/libexec', { mode: '0755', uid: 0 });
  check('no sudoers drop-in for the app', !existsSync('/etc/sudoers.d/laris'));
  check(
    'the deploy and process wrappers are gone (an update removes them)',
    !existsSync('/opt/laris/libexec/laris-process.mts') &&
      !existsSync('/opt/laris/libexec/laris-compose.mts'),
  );
  expect('/etc/systemd/system/laris-restore@.service', { mode: '0644', uid: 0 });
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
  // The app holds no root: no sudo rule at all.
  const sudo = sh('sudo', ['-l', '-U', 'laris']);
  check('sudo: the app may run nothing', !/NOPASSWD|\(root\)|\(ALL/.test(sudo), sudo.trim());
  check(
    'sudo: not even a root program',
    fails('runuser', [
      '-u',
      'laris',
      '--',
      'sudo',
      '-n',
      '/opt/laris/libexec/laris-backup.mts',
      'passphrase',
    ]),
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

function ensurePerson(user = 'anna', uid = 1500) {
  if (fails('id', [user])) {
    sh('useradd', ['--create-home', '--uid', String(uid), '--shell', '/bin/bash', user]);
    sh('chpasswd', [], { input: `${user}:${user}-smoke-password\n` });
  }
}

/** The Linux sign-in and the file explorer, as anna, through the machine's own sshd. */
async function files() {
  console.log('\nLinux sign-in and files (through this machine’s sshd)');
  ensurePerson();
  // Without sudo at first (the "not allowed" check below); an earlier pass gave it back.
  fails('gpasswd', ['-d', 'anna', 'sudo']);
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
  await processes();
  await systemServices();
  await api('DELETE', '/files/session');
}

/** A sleep of `user`, by PID and start time (as the process list names it). */
/** laris-root runs (root's, started by her sudo). */
const larisRootRunning = () =>
  !fails('pgrep', ['-u', 'root', '-f', '^/usr/bin/node /opt/laris/libexec/laris-root.mts']);

async function sleeper(user) {
  const child = spawn(
    'setpriv',
    [`--reuid=${user}`, `--regid=${user}`, '--clear-groups', 'sleep', '300'],
    {
      stdio: 'ignore',
    },
  );
  await sleep(500);
  const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  const startTicks = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)[19];
  const exited = new Promise((r) => child.on('exit', (_, signal) => r(signal)));
  return {
    request: { pid: child.pid, startTicks },
    signal: () => Promise.race([exited, sleep(5000).then(() => 'still running')]),
    stop: () => child.kill('SIGKILL'),
  };
}

/**
 * Ending processes as anna through her Linux session's helper: her own; root's only through her
 * own sudo, unlocked with her password — laris-root, started by it, runs for the unlock; "Lock
 * now" ends it, and so does its own end (idle). No root path of the app's.
 */
async function processes() {
  console.log('\nEnding processes and sudo (as anna, through her helper)');
  const helper = mode('/opt/laris/libexec/laris-helper.mts');
  check(
    'the helper is installed root-owned, runnable, writable by root only',
    helper.uid === 0 && helper.mode === '0755',
    helper.mode,
  );
  const larisRoot = mode('/opt/laris/libexec/laris-root.mts');
  check(
    'laris-root is installed root-owned, runnable, writable by root only',
    larisRoot.uid === 0 && larisRoot.mode === '0755',
    larisRoot.mode,
  );
  const own = await sleeper('anna');
  const end = await api('POST', '/processes/signal', { ...own.request, signal: 'TERM' });
  check('anna ends her own process', end.status === 204, `${end.status} ${end.text}`);
  check('it got SIGTERM', (await own.signal()) === 'SIGTERM');

  const roots = await sleeper('root');
  const locked = await api('POST', '/processes/signal', { ...roots.request, signal: 'KILL' });
  check(
    'root’s needs her sudo, locked (403 sudo_required)',
    locked.status === 403 && locked.json?.code === 'sudo_required',
    `${locked.status} ${locked.text}`,
  );
  const noSudo = await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  check(
    'unlocking sudo without sudo rights: not allowed',
    noSudo.status === 403 && noSudo.json?.code === 'sudo_not_allowed',
    `${noSudo.status} ${noSudo.text}`,
  );
  sh('usermod', ['-aG', 'sudo', 'anna']);
  // Group changes count from the next sign-in.
  await api('POST', '/files/session', { username: 'anna', password: 'anna-smoke-password' });
  const wrong = await api('POST', '/files/session/sudo', { password: 'wrong' });
  check(
    'a wrong sudo password refused',
    wrong.status === 403 && wrong.json?.code === 'sudo_password_wrong',
    `${wrong.status} ${wrong.text}`,
  );
  const unlocked = await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  check(
    'sudo unlocked with her password',
    unlocked.status === 200 && Date.parse(unlocked.json?.sudoUntil) > Date.now(),
    `${unlocked.status} ${unlocked.text}`,
  );
  check('laris-root runs as root while unlocked', larisRootRunning());
  const admin = await api('POST', '/processes/signal', { ...roots.request, signal: 'TERM' });
  check(
    'root’s process ended through her sudo',
    admin.status === 204,
    `${admin.status} ${admin.text}`,
  );
  check('root’s process got SIGTERM', (await roots.signal()) === 'SIGTERM');
  roots.stop();

  const lock = await api('DELETE', '/files/session/sudo');
  const after = await api('GET', '/files/session');
  check(
    '“Lock now” locks sudo, the Linux session stays',
    lock.status === 200 &&
      after.json?.session?.username === 'anna' &&
      after.json?.session?.sudoUntil === null,
    `${lock.status} ${after.text}`,
  );
  await sleep(500);
  check('laris-root ended at “Lock now”', !larisRootRunning());
  const wrongAfterLock = await api('POST', '/files/session/sudo', { password: 'wrong' });
  check(
    'after “Lock now”, a wrong password is refused (sudo’s own cache never unlocks)',
    wrongAfterLock.status === 403 && wrongAfterLock.json?.code === 'sudo_password_wrong',
    `${wrongAfterLock.status} ${wrongAfterLock.text}`,
  );
  const roots2 = await sleeper('root');
  const again = await api('POST', '/processes/signal', { ...roots2.request, signal: 'TERM' });
  check(
    'locked: root’s process needs her sudo again',
    again.status === 403 && again.json?.code === 'sudo_required',
    `${again.status} ${again.text}`,
  );
  // laris-root ending on its own (as after 15 minutes idle): the app sees it locked at once.
  await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  sh('pkill', ['-u', 'root', '-f', '^/usr/bin/node /opt/laris/libexec/laris-root.mts']);
  await sleep(500);
  const ended = await api('GET', '/files/session');
  check('laris-root ended on its own: locked', ended.json?.session?.sudoUntil === null, ended.text);
  const third = await api('POST', '/processes/signal', { ...roots2.request, signal: 'TERM' });
  check(
    'and its actions need her sudo again',
    third.status === 403 && third.json?.code === 'sudo_required',
    `${third.status} ${third.text}`,
  );
  roots2.stop();
  sh('gpasswd', ['-d', 'anna', 'sudo']);
  const init = await api('POST', '/processes/signal', { pid: 1, startTicks: '1', signal: 'KILL' });
  check('PID 1 refused', init.status === 403 || init.status === 404, `${init.status}`);
}

/**
 * The Services page against the real systemd (docs/plans/system_services.md): systemctl's JSON
 * and unix timestamps on this release, a harmless unit of its own started, restarted and stopped
 * through anna's sudo, Laris's own refused.
 */
async function systemServices() {
  console.log('\nSystem services (as anna; changes through her sudo)');
  writeFileSync(
    '/etc/systemd/system/smoke-sleeper.service',
    '[Unit]\nDescription=Laris smoke test\n[Service]\nExecStart=/usr/bin/sleep infinity\n',
  );
  sh('systemctl', ['daemon-reload']);
  const list = await api('GET', '/system/services');
  const byName = Object.fromEntries((list.json?.services ?? []).map((s) => [s.name, s]));
  check(
    'lists the services (systemctl’s JSON)',
    list.status === 200,
    `${list.status} ${list.text.slice(0, 300)}`,
  );
  check(
    'laris.service is there, protected',
    byName['laris.service']?.active === 'active' && byName['laris.service']?.protection === 'laris',
    JSON.stringify(byName['laris.service']),
  );
  check('the test unit is there, inactive', byName['smoke-sleeper.service']?.active === 'inactive');
  const ssh = await api('GET', '/system/services/ssh.service');
  check(
    'a unit’s details (unix timestamps)',
    ssh.status === 200 && Date.parse(ssh.json?.since) > 0 && ssh.json?.protection === 'essential',
    `${ssh.status} ${ssh.text}`,
  );

  const ownJournal = await api('GET', '/system/journal?priority=debug');
  check(
    'journal: anna (no journal group) reads only her own',
    ownJournal.status === 200 && ownJournal.json?.access === 'own',
    `${ownJournal.status} ${ownJournal.text.slice(0, 300)}`,
  );
  const locked = await api('POST', '/system/services/smoke-sleeper.service/start');
  check(
    'starting needs her sudo (403 sudo_required)',
    locked.status === 403 && locked.json?.code === 'sudo_required',
    `${locked.status} ${locked.text}`,
  );
  sh('usermod', ['-aG', 'sudo', 'anna']);
  await api('POST', '/files/session', { username: 'anna', password: 'anna-smoke-password' });
  // Unlocking is limited to 5 a minute: the processes' checks just used them.
  await sleep(61_000);
  const unlocked = await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  check('sudo unlocked again', unlocked.status === 200, `${unlocked.status} ${unlocked.text}`);
  const isActive = () => {
    try {
      return sh('systemctl', ['is-active', 'smoke-sleeper.service']).trim();
    } catch (error) {
      return String(error.stdout ?? '').trim();
    }
  };
  const start = await api('POST', '/system/services/smoke-sleeper.service/start');
  check(
    'starts it through her sudo',
    start.status === 204 && isActive() === 'active',
    `${start.status} ${start.text}`,
  );
  const pid = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'smoke-sleeper.service']).trim();
  const restart = await api('POST', '/system/services/smoke-sleeper.service/restart');
  const pidAfter = sh('systemctl', [
    'show',
    '-p',
    'MainPID',
    '--value',
    'smoke-sleeper.service',
  ]).trim();
  check(
    'restarts it (a new main process)',
    restart.status === 204 && pid !== pidAfter,
    `${restart.status} ${pid} ${pidAfter}`,
  );
  const stop = await api('POST', '/system/services/smoke-sleeper.service/stop');
  check(
    'stops it',
    stop.status === 204 && isActive() === 'inactive',
    `${stop.status} ${stop.text}`,
  );
  const own = await api('POST', '/system/services/laris.service/restart');
  check(
    'Laris’s own refused',
    own.status === 403 && own.json?.code === 'service_protected',
    `${own.status}`,
  );
  const needed = await api('POST', '/system/services/ssh.service/stop');
  check(
    'ssh never stopped',
    needed.status === 403 && needed.json?.code === 'service_protected',
    `${needed.status}`,
  );

  await systemJournal();

  await api('DELETE', '/files/session/sudo');
  sh('gpasswd', ['-d', 'anna', 'sudo']);
  rmSync('/etc/systemd/system/smoke-sleeper.service');
  sh('systemctl', ['daemon-reload']);
}

/** The journal as administrator, through anna's unlocked sudo (systemServices() unlocked it). */
async function systemJournal() {
  console.log('\nSystem journal (as administrator through her sudo)');
  sh('logger', ['-t', 'smoke-journal', '-p', 'user.err', 'a line from the smoke test']);
  const unit = await api(
    'GET',
    '/system/journal?administrator=true&priority=debug&unit=smoke-sleeper.service',
  );
  check(
    'real journal lines for a unit (systemd starting and stopping it)',
    unit.status === 200 &&
      unit.json?.access === 'all' &&
      unit.json.lines.some((line) => /smoke/i.test(line.text)),
    `${unit.status} ${unit.text.slice(0, 400)}`,
  );
  const errors = await api('GET', '/system/journal?administrator=true&priority=error');
  check(
    'an error logged now is there, with its priority and program',
    errors.status === 200 &&
      errors.json.lines.some(
        (line) =>
          line.identifier === 'smoke-journal' &&
          line.priority === 3 &&
          line.text === 'a line from the smoke test',
      ),
    `${errors.status} ${errors.text.slice(-400)}`,
  );
  const all = await api('GET', '/system/journal?administrator=true&priority=debug');
  const first = all.json?.lines?.[0];
  const older = first
    ? await api(
        'GET',
        `/system/journal?administrator=true&priority=debug&before=${encodeURIComponent(first.cursor)}`,
      )
    : null;
  check(
    'pages back from the first line (older, without it)',
    all.status === 200 &&
      (!all.json.more ||
        (older?.status === 200 &&
          older.json.lines.length > 0 &&
          older.json.lines.at(-1).at <= first.at &&
          !older.json.lines.some((line) => line.cursor === first.cursor))),
    `${all.status} more=${all.json?.more} ${older?.status} ${older?.text.slice(0, 200)}`,
  );
  const boots = await api('GET', '/system/journal/boots?administrator=true');
  check(
    'the boots list (journalctl’s JSON)',
    boots.status === 200 && Array.isArray(boots.json?.boots) && boots.json.boots[0]?.offset === 0,
    `${boots.status} ${boots.text.slice(0, 300)}`,
  );
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
  const page = await fetch(`${BASE}/backups`);
  check('the web app is served on the same origin', (await page.text()).includes('<laris-root'));
  const csp = page.headers.get('content-security-policy') ?? '';
  check(
    'the page has its Content Security Policy (scripts only its own)',
    csp.includes("script-src 'self'") && !/script-src[^;]*'unsafe-/.test(csp),
    csp,
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

  // Before any app task: Laris refuses cleanup for a while after one (an image just pulled for
  // an install looks unused).
  await dockerCleanup();

  // anna's sudo and Lock now first (processes): the apps below need her sudo unlocked again.
  await files();

  console.log('\nApps, as anna (not in the docker group: system units through her sudo)');
  // Taken out of the sudo group above (the "not allowed" check): an administrator again.
  sh('usermod', ['-aG', 'sudo', 'anna']);
  await linuxSignIn('anna');
  // The sudo checks above used the minute's unlock attempts (SUDO_LIMIT: 5 a minute).
  await sleep(61_000);
  const unlock = await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  check('anna’s sudo unlocked', unlock.status === 200, `${unlock.status} ${unlock.text}`);
  const navidrome = await installTemplate('navidrome', 'navidrome');
  check(
    'Navidrome runs from her apps folder',
    navidrome.task?.state === 'succeeded' &&
      appOf(await snapshot('containers'), 'navidrome')?.folder === '/home/anna/apps/navidrome',
    JSON.stringify(navidrome).slice(0, 600),
  );
  check(
    'its data folder belongs to anna',
    mode('/home/anna/apps/navidrome/data').uid === uidOf('anna'),
  );
  const ollama = await installTemplate('ollama', 'ollama');
  check(
    'Ollama installed',
    ollama.task?.state === 'succeeded',
    JSON.stringify(ollama).slice(0, 600),
  );
  // Reached from the machine itself, refused on its network address (the template's default).
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

  console.log('\nBacking up, through anna’s sudo');
  // Unlocked again: the installs above may have taken longer than laris-root's 15 idle minutes.
  await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  const plan = await api('POST', '/backups/plan', {
    destination: '/mnt/backup',
    schedule: { frequency: 'daily', time: '03:00' },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    items: [{ kind: 'app', project: 'navidrome', folders: [], skip: [], mode: 'stop' }],
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
  const again = await api('POST', '/backups/passphrase', {});
  check(
    'the passphrase again, through her sudo',
    typeof again.json?.passphrase === 'string',
    `${again.status}`,
  );

  console.log('\nRestoring into a new folder (its own unit)');
  const items = (await api('GET', '/backups/plan')).json?.plan?.items ?? [];
  const item = items.find((i) => i.project === 'navidrome');
  const archives = (await api('GET', `/backups/items/${item?.id}/archives`)).json?.archives ?? [];
  const restore = await api('POST', '/backups/restores', {
    itemId: item?.id,
    archive: archives[0]?.name,
    target: '/home/anna/restored',
  });
  check('restore started', restore.status === 202, `${restore.status} ${restore.text}`);
  const restored = await until(
    'the restore finished',
    async () => {
      const r = await api('GET', `/backups/restores/${restore.json?.restoreId}`);
      return { done: r.json?.status && r.json.status !== 'running', value: r.json };
    },
    10 * 60_000,
  );
  check(
    'restored with its full paths',
    restored.value?.status === 'succeeded' &&
      existsSync('/home/anna/restored/home/anna/apps/navidrome/compose.yml'),
    JSON.stringify(restored.value).slice(0, 400),
  );

  console.log(
    '\nRestoring back where it was: started as it was, then its settings applied (Apply)',
  );
  const folder = '/home/anna/apps/navidrome';
  const published = () =>
    sh('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project=navidrome',
      '--format',
      '{{.Ports}}',
    ]);
  const details = (await api('GET', `/apps/navidrome?folder=${encodeURIComponent(folder)}`)).json;
  const saved = await api('PUT', '/apps/navidrome/files', {
    folder,
    compose: details?.compose,
    env: details?.env.replace(/^WEB_PORT=.*$/m, 'WEB_PORT=4599'),
    hash: details?.hash,
    overwrite: false,
  });
  const applied = await waitTask('navidrome', folder);
  check(
    'a changed setting saved and applied',
    saved.status === 202 && applied?.state === 'succeeded' && published().includes(':4599->'),
    `${saved.status} ${published()}`,
  );
  const back = await api('POST', '/backups/restores', {
    itemId: item?.id,
    archive: archives[0]?.name,
    target: null,
  });
  const backDone = await until(
    'the restore back where it was finished',
    async () => {
      const r = await api('GET', `/backups/restores/${back.json?.restoreId}`);
      return { done: r.json?.status && r.json.status !== 'running', value: r.json };
    },
    10 * 60_000,
  );
  check(
    'restored where it was: its files back, the app started as it was',
    backDone.value?.status === 'succeeded' &&
      backDone.value?.appWasRunning === true &&
      published().includes(':4599->') &&
      readFileSync(`${folder}/.env`, 'utf8').includes('WEB_PORT=4533'),
    `${JSON.stringify(backDone.value).slice(0, 400)} ${published()}`,
  );
  const apply = await api('POST', `/backups/restores/${back.json?.restoreId}/apply`, { folder });
  const reapplied = await waitTask('navidrome', folder);
  check(
    'the restored settings applied, as her: the setting from the backup runs again',
    apply.status === 202 && reapplied?.state === 'succeeded' && published().includes(':4533->'),
    `${apply.status} ${apply.text} ${published()}`,
  );
  const offered = await api('GET', `/backups/restores/${back.json?.restoreId}`);
  check('Apply offered once', offered.json?.appWasRunning === false, JSON.stringify(offered.json));

  console.log('\nApps, as bob (in the docker group: user units, no sudo)');
  ensurePerson('bob', 1501);
  sh('usermod', ['-aG', 'docker', 'bob']);
  sh('loginctl', ['enable-linger', 'bob']);
  await linuxSignIn('bob');
  const hello = await installPasted(
    'hello',
    'services:\n  hello:\n    image: busybox:${HELLO_VERSION:-1.37}\n    command: ["sleep", "3600"]\n    volumes:\n      - ./data:/data\n      - cache:/cache\nvolumes:\n  cache:\n',
  );
  check(
    'a pasted file runs as a user unit',
    hello.task?.state === 'succeeded' && hello.task.system === false,
    JSON.stringify(hello).slice(0, 600),
  );
  // What Compose says the file mounts (this machine's Compose version, every profile).
  const removal = await api('GET', '/apps/hello/removal?folder=%2Fhome%2Fbob%2Fapps%2Fhello');
  const listed = (removal.json?.items ?? []).map((i) => `${i.kind}:${i.path}`);
  check(
    'its removal lists its data folder and its volume',
    listed.join(' ') ===
      'settings:/home/bob/apps/hello folder:/home/bob/apps/hello/data volume:hello_cache',
    `${removal.status} ${removal.text.slice(0, 400)}`,
  );
  const removed = await api('POST', '/apps/hello/remove', { folder: '/home/bob/apps/hello' });
  const down = await waitTask('hello', '/home/bob/apps/hello');
  const deleted = await api('POST', '/apps/hello/delete', {
    folder: '/home/bob/apps/hello',
    settings: true,
    folders: ['/home/bob/apps/hello/data'],
    volumes: ['hello_cache'],
  });
  check(
    'removed, its folder and volume deleted as bob',
    removed.status === 202 &&
      down?.state === 'succeeded' &&
      deleted.status === 204 &&
      !existsSync('/home/bob/apps/hello') &&
      !sh('docker', ['volume', 'ls', '-q']).split('\n').includes('hello_cache'),
    `${removed.status} ${down?.state} ${deleted.status} ${deleted.text}`,
  );
  await api('DELETE', '/files/session');

  await profile();
  done();
}

async function update() {
  console.log('After running the installer again');
  check('the app answers', (await api('GET', '/health')).status === 200);
  check('still set up', (await api('GET', '/auth/status')).json?.needsSetup === false);
  await signIn();
  const apps = await api('GET', '/apps');
  check(
    'Navidrome still runs',
    apps.json?.apps?.some((a) => a.name === 'navidrome' && a.state === 'running'),
    apps.text.slice(0, 300),
  );
  const chatTables = sh('docker', [
    'exec',
    'laris-postgres-1',
    'psql',
    '-tA',
    '-U',
    'laris_owner',
    '-d',
    'laris',
    '-c',
    "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('Chat', 'ChatMessage')",
  ]).trim();
  check('migrated: the Assistant’s chat tables are gone', chatTables === '0', chatTables);
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

/** Docker's unused data, freed through the proxy socket: the prunes really run here. */
async function dockerCleanup() {
  console.log('\nDocker cleanup');
  const UNUSED_IMAGE = 'busybox:1.36';
  sh('docker', ['pull', '-q', UNUSED_IMAGE]);
  const before = await api('GET', '/docker/cleanup');
  check(
    'an unused image listed',
    before.json?.images?.some((i) => i.tags.includes(UNUSED_IMAGE)),
    before.text.slice(0, 300),
  );
  const pruned = await api('POST', '/docker/cleanup/prune');
  check(
    'unused images and the build cache freed',
    pruned.status === 200 && pruned.json?.bytesFreed > 0 && pruned.json?.images >= 1,
    `${pruned.status} ${pruned.text}`,
  );
  check(
    'the image is gone, the platform’s stay',
    fails('docker', ['image', 'inspect', UNUSED_IMAGE]) &&
      (await snapshot('containers')).containers?.every((c) => c.state === 'running'),
  );

  // A volume in use (a created, never started container holds it), the platform's own, a free one.
  const proxyImage = sh('docker', [
    'inspect',
    '-f',
    '{{.Config.Image}}',
    'laris-docker-proxy-1',
  ]).trim();
  sh('docker', ['volume', 'create', 'smoke_used']);
  sh('docker', ['create', '--name', 'smoke-holder', '-v', 'smoke_used:/x', proxyImage]);
  sh('docker', [
    'volume',
    'create',
    '--label',
    'com.docker.compose.project=laris',
    'smoke_platform',
  ]);
  sh('docker', ['volume', 'create', 'smoke_unused']);
  const listed = (await api('GET', '/docker/cleanup')).json?.volumes?.map((v) => v.name) ?? [];
  check(
    'unused volumes listed, not the platform’s or one in use',
    listed.includes('smoke_unused') &&
      !listed.includes('smoke_platform') &&
      !listed.includes('smoke_used'),
    listed.join(', '),
  );
  const sizes = await api('GET', '/docker/cleanup/volume-sizes');
  check(
    'volume sizes counted',
    sizes.status === 200 && 'smoke_unused' in (sizes.json?.sizes ?? {}),
    `${sizes.status} ${sizes.text.slice(0, 200)}`,
  );
  const inUse = await api('DELETE', '/docker/cleanup/volumes/smoke_used');
  check('a volume in use refused (409)', inUse.status === 409, `${inUse.status} ${inUse.text}`);
  const own = await api('DELETE', '/docker/cleanup/volumes/smoke_platform');
  check('the platform’s volume refused (403)', own.status === 403, `${own.status} ${own.text}`);
  const removed = await api('DELETE', '/docker/cleanup/volumes/smoke_unused');
  check(
    'an unused volume deleted',
    removed.status === 204 && fails('docker', ['volume', 'inspect', 'smoke_unused']),
    `${removed.status} ${removed.text}`,
  );
  sh('docker', ['rm', 'smoke-holder']);
  sh('docker', ['volume', 'rm', 'smoke_used', 'smoke_platform']);
}

/** Signs the app session in to Linux as this person. */
async function linuxSignIn(user) {
  const body = { username: user, password: `${user}-smoke-password` };
  let res = await api('POST', '/files/session', body);
  // Five Linux sign-ins a minute (the checks before use some): wait it out once.
  if (res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    res = await api('POST', '/files/session', body);
  }
  check(`signed in to Linux as ${user}`, res.status === 200, `${res.status} ${res.text}`);
}

/** A task's end, read back from the app's folder (the end of its output, for a failure). */
async function waitTask(name, folder) {
  const end = await until(
    `${name}: its task finished`,
    async () => {
      const r = await api('GET', `/apps/${name}/task?folder=${encodeURIComponent(folder)}`);
      const task = r.json?.task;
      return { done: task && task.state !== 'running', value: task };
    },
    20 * 60_000,
  );
  return end.value ? { ...end.value, output: end.value.output.slice(-20) } : null;
}

/** An app from a template, as the signed-in person: the form's values, then the install. */
async function installTemplate(id, name) {
  const { compose } = (await api('GET', `/catalog/${id}`)).json ?? {};
  const fields = (await api('POST', '/apps/fields', { template: id })).json;
  const env = (fields?.fields ?? []).map((f) => `${f.key}=${f.value}`).join('\n') + '\n';
  const started = await api('POST', '/apps', { name, folder: null, template: id, compose, env });
  check(`${name}: install started`, started.status === 202, `${started.status} ${started.text}`);
  return {
    started: started.json,
    task: started.json ? await waitTask(name, started.json.folder) : null,
  };
}

async function installPasted(name, compose) {
  const started = await api('POST', '/apps', {
    name,
    folder: null,
    template: null,
    compose,
    env: '',
  });
  check(`${name}: install started`, started.status === 202, `${started.status} ${started.text}`);
  return {
    started: started.json,
    task: started.json ? await waitTask(name, started.json.folder) : null,
  };
}

/** An app as the containers topic's snapshot shows it (one per Compose project). */
function appOf(snapshot, name) {
  const own = (snapshot.containers ?? []).filter((c) => c.composeProject === name);
  return own.length ? { folder: own[0].composeWorkingDir } : null;
}
