// The installer's smoke test, run as root inside a freshly installed machine (tools/vm/):
//   node smoke.mjs install   after the first install: setup, sign-in, containers through the proxy
//                            socket, ending processes as a person, apps installed as a person
//                            (through her sudo; with the docker group as user units), a backup,
//                            a restore to a new folder and one back where it was (the app brought
//                            up with the restored settings) through her sudo, and the security
//                            setup (files, no sudo for the app, who reaches the proxy), and
//                            freeing Docker's unused data, and the machine check (the
//                            installer's checks and the page's)
//   node smoke.mjs update    after a restart or running the installer again: everything is
//                            still there (--installed-again: and the installed version kept)
//   node smoke.mjs self-update <version> <outcome>
//                            an update by ilex-update from the test's release folder: its
//                            outcome (updated, rolled_back), the version answering, and then
//                            everything still there
//   node smoke.mjs recover-cli
//                            after ilex-uninstall and a fresh install: Ilexarium brought back
//                            from the backup disk by `ilex-recover --yes` — the owner signs in,
//                            the plan and its backups are there, an app restores back in place
//   node smoke.mjs recover-app
//                            the same through the app: a throwaway account, the Linux sign-in,
//                            her sudo, Backups → Restore Ilexarium (its own unit)
//   node smoke.mjs https     HTTPS on the network as app.env says (on: the socket, the
//                            certificate in /etc/ilex/tls served, a sign-in over it; off: the
//                            port closed) — after the install test changed it
// Exits 1 on the first failure. Uses only Node's own modules and the app's `ws`.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Where the app answers: the machine's settings (the person's — the install test moves it to
// another port before updating), read like the installer's app_url.
function appSetting(name) {
  const value =
    readFileSync('/etc/ilex/app.env', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim() ?? '';
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}
const HOST = appSetting('HOST');
const EVERY_ADDRESS = HOST === '' || HOST === '0.0.0.0' || HOST === '::';
const PORT = appSetting('PORT') || '3000';
const ADDRESS = EVERY_ADDRESS ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
// The machine's SSH server unit (the installer found it) and its administrators' group.
const SSH_UNIT =
  JSON.parse(readFileSync('/etc/ilex/wrappers.json', 'utf8')).update.sshUnit ?? 'ssh.service';
const ADMINS = existsSync('/etc/arch-release') ? 'wheel' : 'sudo';
const BASE = `http://${ADDRESS}:${PORT}`;
// HTTPS on the network (ilex-https.socket): on when app.env has HTTPS_HOST.
const HTTPS_HOST = appSetting('HTTPS_HOST');
const HTTPS_PORT = appSetting('HTTPS_PORT') || '3443';
const TLS = '/etc/ilex/tls';
// The certificate the install served, to see an update keep it (the install test writes it again
// when it puts another one there).
const KEPT_FINGERPRINT = '/root/https-fingerprint';
const ORIGIN = BASE;
const USER = 'owner';
// Where ilex-uninstall keeps the backup settings, and the test's backup disk.
const KEPT_PASSPHRASE = '/root/ilex-backup-settings/backup.passphrase';
const REPOSITORY = '/mnt/backup/ilex-backups';

const PASSWORD = 'correct horse battery staple';
const { default: WebSocket } = await import('/opt/ilex/app/node_modules/ws/index.js');

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

/** The first snapshot of a realtime topic (asked at `address`, the app's by default). */
function snapshot(topic, address = ADDRESS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}:${PORT}/api/ws`, {
      headers: { Cookie: cookie, Origin: `http://${address}:${PORT}` },
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
function expect(path, want) {
  const got = mode(path);
  check(
    `${path}: ${JSON.stringify(want)}`,
    Object.entries(want).every(([k, v]) => got[k] === v),
    JSON.stringify(got),
  );
}

async function signIn() {
  const login = await api('POST', '/auth/login', { username: USER, password: PASSWORD });
  check('signs in', login.status === 200, `${login.status} ${login.text}`);
}

async function securitySetup() {
  console.log('\nThe security setup');
  const app = uidOf('ilex');
  const appGroup = gidOf('ilex');
  expect('/etc/ilex/master.key', { mode: '0400', uid: app });
  expect('/etc/ilex/app.env', { mode: '0640', uid: 0, gid: appGroup });
  expect('/etc/ilex/database.env', { mode: '0600', uid: 0 });
  expect('/etc/ilex/database-owner-password', { mode: '0600', uid: 0 });
  expect('/etc/ilex/wrappers.json', { mode: '0644', uid: 0 });
  expect('/opt/ilex/libexec', { mode: '0755', uid: 0 });
  expect('/etc/ilex/release.env', { mode: '0644', uid: 0 });
  expect('/etc/ilex/release.pub', { mode: '0644', uid: 0 });
  const release = readFileSync('/etc/ilex/release.env', 'utf8');
  check(
    'release.env: where updates come from, nothing about how the machine is reached',
    release === 'RELEASE_URL=https://localhost:8443/releases\n',
    release,
  );
  const appSettings = readFileSync('/etc/ilex/app.env', 'utf8');
  check(
    'app.env: the machine’s settings only (where the app listens, its database)',
    /^HOST=/m.test(appSettings) &&
      /^DATABASE_URL=/m.test(appSettings) &&
      !/^(NODE_ENV|DOCKER_HOST|WEB_ROOT|SETUP_TOKEN_FILE|TRUST_PROXY)=/m.test(appSettings),
  );
  const environment = sh('systemctl', ['show', '-p', 'Environment', '--value', 'ilex']);
  check(
    'ilex.service: the release’s settings',
    ['NODE_ENV=production', 'DOCKER_HOST=unix:///run/ilex/proxy/docker.sock'].every((setting) =>
      environment.includes(setting),
    ),
    environment,
  );
  check('no sudoers drop-in for the app', !existsSync('/etc/sudoers.d/ilex'));
  check(
    'the deploy and process wrappers are gone (an update removes them)',
    !existsSync('/opt/ilex/libexec/ilex-process.mts') &&
      !existsSync('/opt/ilex/libexec/ilex-compose.mts'),
  );
  expect('/etc/systemd/system/ilex-restore@.service', { mode: '0644', uid: 0 });
  expect('/var/lib/ilex', { mode: '0755', uid: 0 });
  expect('/var/lib/ilex/app', { mode: '0700', uid: app });
  expect('/var/lib/ilex/backups', { mode: '0750', uid: 0, gid: appGroup });
  // The proxy's own account, never the image's uid 99, which the host may have given someone.
  const proxyAccount = uidOf('ilex-proxy');
  check('the proxy has an account of its own', proxyAccount !== 99 && proxyAccount !== app);
  expect('/run/ilex/proxy', { mode: '0750', uid: proxyAccount, gid: appGroup });
  const proxyProcess = sh('docker', [
    'inspect',
    '--format',
    '{{.State.Pid}}',
    'ilex-docker-proxy-1',
  ]).trim();
  check(
    'the proxy runs as ilex-proxy',
    proxyProcess !== '0' && mode(`/proc/${proxyProcess}`).uid === proxyAccount,
    `pid ${proxyProcess}`,
  );
  // As a bare uid, no account needed; the proxy's own uid first, so a missing setpriv can't pass.
  const refusedAs = (uid, gid) =>
    fails('setpriv', [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      '--clear-groups',
      '--',
      'curl',
      '-sf',
      '--unix-socket',
      '/run/ilex/proxy/docker.sock',
      'http://d/_ping',
    ]);
  check('the proxy’s uid reaches its socket', !refusedAs(proxyAccount, gidOf('ilex-proxy')));
  check('uid 99 can’t reach the proxy’s socket', refusedAs(99, 99));
  check(
    'the app’s user is not in the docker group',
    !sh('id', ['-nG', 'ilex']).split(/\s+/).includes('docker'),
  );
  const appProcess = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'ilex']).trim();
  check('the app runs as ilex', mode(`/proc/${appProcess}`).uid === app);
  check(
    'the app listens only where app.env says, not on every address',
    EVERY_ADDRESS ||
      !new RegExp(`(0\\.0\\.0\\.0|\\[::\\]|\\*):${PORT}\\b`).test(sh('ss', ['-ltnH'])),
  );
  check(
    'Postgres listens on 127.0.0.1 only',
    !/0\.0\.0\.0:5432|\[::\]:5432|\*:5432/.test(sh('ss', ['-ltnH'])),
  );
  check('the proxy has no TCP port', !/:2375\b/.test(sh('ss', ['-ltnH'])));
  // The app holds no root: no sudo rule at all.
  const sudo = sh('sudo', ['-l', '-U', 'ilex']);
  check('sudo: the app may run nothing', !/NOPASSWD|\(root\)|\(ALL/.test(sudo), sudo.trim());
  check(
    'sudo: not even a root program',
    fails('runuser', [
      '-u',
      'ilex',
      '--',
      'sudo',
      '-n',
      '/opt/ilex/libexec/ilex-backup.mts',
      'passphrase',
    ]),
  );
  check(
    'the app can’t read the database owner’s password',
    fails('runuser', ['-u', 'ilex', '--', 'cat', '/etc/ilex/database-owner-password']),
  );
  const ownerPassword = readFileSync('/etc/ilex/database-owner-password', 'utf8');
  check(
    'the database owner’s password in neither database.env nor inspect through the proxy',
    ownerPassword.length >= 32 &&
      !readFileSync('/etc/ilex/database.env', 'utf8').includes(ownerPassword) &&
      !sh('runuser', [
        '-u',
        'ilex',
        '--',
        'curl',
        '-sf',
        '--unix-socket',
        '/run/ilex/proxy/docker.sock',
        'http://d/containers/ilex-postgres-1/json',
      ]).includes(ownerPassword),
  );
  check(
    'the app can’t open Docker’s socket',
    fails('runuser', [
      '-u',
      'ilex',
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
      'ilex',
      '--',
      'curl',
      '-sf',
      '--unix-socket',
      '/run/ilex/proxy/docker.sock',
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
      '/run/ilex/proxy/docker.sock',
      'http://d/_ping',
    ]),
  );
  check(
    'the proxy still refuses what isn’t allowed',
    sh('runuser', [
      '-u',
      'ilex',
      '--',
      'curl',
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--unix-socket',
      '/run/ilex/proxy/docker.sock',
      '-X',
      'POST',
      'http://d/containers/create',
    ]).trim() === '403',
  );
  // The database: the app's role may read and write data, nothing more.
  const role = sh('docker', [
    'exec',
    'ilex-postgres-1',
    'psql',
    '-tA',
    '-U',
    'ilex_owner',
    '-d',
    'ilex',
    '-c',
    "SELECT rolsuper, rolcreatedb, rolcreaterole, has_table_privilege('ilex', '\"User\"', 'SELECT'), has_table_privilege('ilex', '_prisma_migrations', 'SELECT'), has_schema_privilege('ilex', 'public', 'CREATE') FROM pg_roles WHERE rolname = 'ilex'",
  ]).trim();
  check(
    'the app’s database role reads data, can’t migrate or create',
    role === 'f|f|f|t|f|f',
    role,
  );
  await ownPort();
  await httpsPort();
  if (HTTPS_HOST && !existsSync(KEPT_FINGERPRINT)) {
    writeFileSync(KEPT_FINGERPRINT, `${fingerprintOf(`${TLS}/cert.pem`)}\n`);
  }
}

/**
 * The app's port is systemd's (ilex.socket), on every address the app answers on: an ordinary
 * account can't take it, not even while ilex.service is stopped, and the next request starts the
 * app again. With 127.0.0.1 comes ::1 ("localhost"), served by the app too.
 */
async function ownPort() {
  console.log('\nThe app’s port (ilex.socket)');
  const active = (unit) => !fails('systemctl', ['is-active', '--quiet', unit]);
  check(
    'ilex.socket is enabled and listening',
    active('ilex.socket') && sh('systemctl', ['is-enabled', 'ilex.socket']).trim() === 'enabled',
  );
  const listen = socketListen('ilex.socket');
  const expected = expectedListen(HOST || '127.0.0.1', PORT);
  check(
    `ilex.socket listens where app.env says (${expected.join(', ')})`,
    listen.length === expected.length && expected.every((at) => listen.includes(at)),
    listen.join(' '),
  );
  const held = () => heldBySystemd(listen);
  check('systemd (pid 1) holds each of them', held(), sh('ss', ['-ltnpH']));
  if (listen.includes(`[::1]:${PORT}`)) {
    const answer = await fetch(`http://[::1]:${PORT}/api/health`).catch(() => null);
    check('the app answers on [::1] too', answer?.status === 200, `${answer?.status}`);
    const containers = await snapshot('containers', '[::1]').catch((error) => ({ error }));
    check(
      'its WebSocket too (one server for both sockets)',
      containers.dockerAvailable === true,
      JSON.stringify(containers).slice(0, 200),
    );
  }

  ensurePerson();
  sh('systemctl', ['stop', 'ilex.service'], { stdio: ['ignore', 'pipe', 'ignore'] });
  check('ilex.service stopped, ilex.socket still listening', !active('ilex.service') && held());
  for (const at of listen) {
    const address = at.slice(0, at.lastIndexOf(':')).replace(/^\[|\]$/g, '');
    for (const reusePort of [false, true]) {
      const code = `const s = require('node:net').createServer();
        s.on('error', (e) => console.log(e.code));
        s.listen({ host: ${JSON.stringify(address)}, port: ${PORT}, reusePort: ${reusePort} }, () => (console.log('BOUND'), s.close()));`;
      const got = sh('runuser', ['-u', 'anna', '--', '/usr/bin/node', '-e', code]).trim();
      check(
        `anna can’t take ${at} while the app is stopped${reusePort ? ' (SO_REUSEPORT)' : ''}`,
        got === 'EADDRINUSE',
        got,
      );
    }
  }
  // On a connection of its own: fetch would reuse one the stopped app closed while the calls
  // above blocked the event loop.
  const woken = await new Promise((resolve) => {
    const request = get(`${BASE}/api/health`, { agent: false, timeout: 90_000 }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', (error) => resolve(String(error)));
  });
  check(
    'a request starts the app again (it waits, no one else answers)',
    woken === 200 && active('ilex.service'),
    `${woken}`,
  );
}

/** Where a socket listens, as the generator writes it: the host, with its loopback partner. */
function expectedListen(host, port) {
  const own = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const partner = { '127.0.0.1': '[::1]', '0.0.0.0': '[::1]', '::1': '127.0.0.1' }[host];
  return partner ? [own, `${partner}:${port}`] : [own];
}

function socketListen(unit) {
  return sh('systemctl', ['show', '-p', 'Listen', '--value', unit])
    .trim()
    .split(/\s+/)
    .filter((word) => word && word !== '(Stream)');
}

function heldBySystemd(listen) {
  const lines = sh('ss', ['-ltnpH']).split('\n');
  return listen.every((at) =>
    lines.some((line) => line.split(/\s+/)[3] === at && /\("systemd",pid=1,/.test(line)),
  );
}

const fingerprintOf = (file) =>
  sh('openssl', ['x509', '-noout', '-fingerprint', '-sha256', '-in', file])
    .trim()
    .replace(/^[^=]*=/, '');

/**
 * A request over HTTPS, trusting whatever certificate answers — which one is checked by its
 * fingerprint (a certificate of the person's own needn't name the address asked).
 */
function overHttps(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { method, headers, rejectUnauthorized: false, agent: false, timeout: 20_000 },
      (response) => {
        const fingerprint = response.socket.getPeerCertificate().fingerprint256;
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, text, fingerprint }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

async function httpsPort() {
  console.log('\nHTTPS on the network (ilex-https.socket)');
  const active = !fails('systemctl', ['is-active', '--quiet', 'ilex-https.socket']);
  const enabled = !fails('systemctl', ['is-enabled', '--quiet', 'ilex-https.socket']);
  const local = `https://127.0.0.1:${HTTPS_PORT}`;
  if (!HTTPS_HOST) {
    check('off without HTTPS_HOST: ilex-https.socket disabled and stopped', !active && !enabled);
    const answer = await overHttps(`${local}/api/health`).catch((error) => String(error));
    check(`nothing answers on ${HTTPS_PORT}`, /ECONNREFUSED/.test(answer), JSON.stringify(answer));
    return;
  }
  check('ilex-https.socket is enabled and listening', active && enabled);
  const listen = socketListen('ilex-https.socket');
  const expected = expectedListen(HTTPS_HOST, HTTPS_PORT);
  check(
    `it listens where app.env says (${expected.join(', ')})`,
    listen.length === expected.length && expected.every((at) => listen.includes(at)),
    listen.join(' '),
  );
  check('systemd (pid 1) holds them', heldBySystemd(listen), sh('ss', ['-ltnpH']));
  expect(`${TLS}/key.pem`, { mode: '0640', uid: 0, gid: gidOf('ilex') });
  expect(`${TLS}/cert.pem`, { uid: 0 });
  const file = fingerprintOf(`${TLS}/cert.pem`);
  const health = await overHttps(`${local}/api/health`).catch((error) => ({
    error: String(error),
  }));
  check(
    `the app answers on ${local} with the certificate in ${TLS}`,
    health.status === 200 && health.fingerprint === file,
    JSON.stringify(health).slice(0, 300),
  );
  if (existsSync(KEPT_FINGERPRINT)) {
    check(
      'the certificate kept as it was',
      readFileSync(KEPT_FINGERPRINT, 'utf8').trim() === file,
      file,
    );
  }
  const network = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && !address.internal && address.family === 'IPv4')?.address;
  if (network && HTTPS_HOST === '0.0.0.0') {
    const there = await overHttps(`https://${network}:${HTTPS_PORT}/api/health`).catch((error) => ({
      error: String(error),
    }));
    check(`…and on the machine’s network address (${network})`, there.status === 200);
  }
  const login = await overHttps(`${local}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: local, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  const session = [login.headers['set-cookie'] ?? []]
    .flat()
    .find((line) => line.startsWith('__Host-sid='));
  check(
    'signs in over HTTPS, with a Secure session cookie',
    login.status === 200 && /;\s*secure/i.test(session ?? ''),
    `${login.status} ${login.text}`,
  );
  const me = await overHttps(`${local}/api/auth/me`, {
    headers: { Cookie: session?.split(';')[0] ?? '' },
  });
  check('…which works there', me.status === 200, `${me.status}`);
  const containers = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${HTTPS_PORT}/api/ws`, {
      headers: { Cookie: session?.split(';')[0] ?? '', Origin: local },
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => (ws.terminate(), resolve(null)), 20_000);
    ws.on('open', () =>
      ws.send(JSON.stringify({ event: 'subscribe', data: { topic: 'containers' } })),
    );
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.event === 'containers:snapshot') {
        clearTimeout(timer);
        ws.close();
        resolve(message.data);
      }
    });
    ws.on('error', () => (clearTimeout(timer), resolve(null)));
  });
  check(
    'the WebSocket over HTTPS too (one server for every socket)',
    containers?.dockerAvailable === true,
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
  fails('gpasswd', ['-d', 'anna', ADMINS]);
  const effective = (addr) =>
    sh('sshd', ['-T', '-C', `user=anna,host=client,addr=${addr}`]).match(
      /^passwordauthentication (\w+)/im,
    )?.[1];
  check('sshd: password logins from 127.0.0.1', effective('127.0.0.1') === 'yes');
  check('sshd: password logins from ::1', effective('::1') === 'yes');
  // The test machine had no SSH server: the installer's listens on this machine only.
  const listening = sh('ss', ['-Htln', 'sport = :22'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/)[3]);
  check(
    'sshd: an SSH server the installer installed listens on this machine only',
    existsSync('/etc/ssh/sshd_config.d/ilex-listen.conf') &&
      listening.length > 0 &&
      listening.every((address) => address === '127.0.0.1:22' || address === '[::1]:22'),
    listening.join(' '),
  );
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
/** ilex-root runs (root's, started by her sudo). */
const ilexRootRunning = () =>
  !fails('pgrep', ['-u', 'root', '-f', '^/usr/bin/node /opt/ilex/libexec/ilex-root.mts']);

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
 * own sudo, unlocked with her password — ilex-root, started by it, runs for the unlock; "Lock
 * now" ends it, and so does its own end (idle). No root path of the app's.
 */
async function processes() {
  console.log('\nEnding processes and sudo (as anna, through her helper)');
  const helper = mode('/opt/ilex/libexec/ilex-helper.mts');
  check(
    'the helper is installed root-owned, runnable, writable by root only',
    helper.uid === 0 && helper.mode === '0755',
    helper.mode,
  );
  const ilexRoot = mode('/opt/ilex/libexec/ilex-root.mts');
  check(
    'ilex-root is installed root-owned, runnable, writable by root only',
    ilexRoot.uid === 0 && ilexRoot.mode === '0755',
    ilexRoot.mode,
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
  sh('usermod', ['-aG', ADMINS, 'anna']);
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
  check('ilex-root runs as root while unlocked', ilexRootRunning());
  const admin = await api('POST', '/processes/signal', { ...roots.request, signal: 'TERM' });
  check(
    'root’s process ended through her sudo',
    admin.status === 204,
    `${admin.status} ${admin.text}`,
  );
  check('root’s process got SIGTERM', (await roots.signal()) === 'SIGTERM');
  roots.stop();

  // Files as administrator: root's SFTP, OpenSSH's sftp-server started by the same unlock.
  const rootList = await api('GET', '/files/list?path=%2Froot&root=true');
  check(
    'Files as administrator: /root listed as root',
    rootList.status === 200 && Array.isArray(rootList.json?.entries),
    `${rootList.status} ${rootList.text}`,
  );
  const asAnna = await api('GET', '/files/list?path=%2Froot');
  check(
    'and the plain Files stay anna’s (/root refused)',
    asAnna.status === 403 && asAnna.json?.code === 'permission_denied',
    `${asAnna.status} ${asAnna.text}`,
  );

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
  check('ilex-root ended at “Lock now”', !ilexRootRunning());
  const rootAfterLock = await api('GET', '/files/list?path=%2Froot&root=true');
  check(
    'after “Lock now”, Files as administrator needs sudo again',
    rootAfterLock.status === 403 && rootAfterLock.json?.code === 'sudo_required',
    `${rootAfterLock.status} ${rootAfterLock.text}`,
  );
  check('root’s sftp-server ended at “Lock now”', fails('pgrep', ['-u', 'root', 'sftp-server']));
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
  // ilex-root ending on its own (as after 15 minutes idle): the app sees it locked at once.
  await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  sh('pkill', ['-u', 'root', '-f', '^/usr/bin/node /opt/ilex/libexec/ilex-root.mts']);
  await sleep(500);
  const ended = await api('GET', '/files/session');
  check('ilex-root ended on its own: locked', ended.json?.session?.sudoUntil === null, ended.text);
  const third = await api('POST', '/processes/signal', { ...roots2.request, signal: 'TERM' });
  check(
    'and its actions need her sudo again',
    third.status === 403 && third.json?.code === 'sudo_required',
    `${third.status} ${third.text}`,
  );
  roots2.stop();
  sh('gpasswd', ['-d', 'anna', ADMINS]);
  const init = await api('POST', '/processes/signal', { pid: 1, startTicks: '1', signal: 'KILL' });
  check('PID 1 refused', init.status === 403 || init.status === 404, `${init.status}`);
}

/**
 * The Services page against the real systemd: systemctl's JSON
 * and unix timestamps on this release, a harmless unit of its own started, restarted and stopped
 * through anna's sudo, Ilexarium's own refused.
 */
async function systemServices() {
  console.log('\nSystem services (as anna; changes through her sudo)');
  writeFileSync(
    '/etc/systemd/system/smoke-sleeper.service',
    '[Unit]\nDescription=Ilexarium smoke test\n[Service]\nExecStart=/usr/bin/sleep infinity\n',
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
    'ilex.service is there, protected',
    byName['ilex.service']?.active === 'active' && byName['ilex.service']?.protection === 'ilex',
    JSON.stringify(byName['ilex.service']),
  );
  check('the test unit is there, inactive', byName['smoke-sleeper.service']?.active === 'inactive');
  const ssh = await api('GET', `/system/services/${SSH_UNIT}`);
  check(
    'a unit’s details (unix timestamps)',
    ssh.status === 200 && Date.parse(ssh.json?.since) > 0 && ssh.json?.protection === 'essential',
    `${ssh.status} ${ssh.text}`,
  );

  // Her helper started at "Lock now" (processes), while she was an administrator: on Arch, wheel
  // is one of journald's groups too.
  const journalAccess = ADMINS === 'wheel' ? 'all' : 'own';
  const ownJournal = await api('GET', '/system/journal?priority=debug');
  check(
    `journal: anna reads ${journalAccess === 'own' ? 'only her own (no journal group)' : 'all (wheel)'}`,
    ownJournal.status === 200 && ownJournal.json?.access === journalAccess,
    `${ownJournal.status} ${ownJournal.text.slice(0, 300)}`,
  );
  const locked = await api('POST', '/system/services/smoke-sleeper.service/start');
  check(
    'starting needs her sudo (403 sudo_required)',
    locked.status === 403 && locked.json?.code === 'sudo_required',
    `${locked.status} ${locked.text}`,
  );
  sh('usermod', ['-aG', ADMINS, 'anna']);
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
  const own = await api('POST', '/system/services/ilex.service/restart');
  check(
    'Ilexarium’s own refused',
    own.status === 403 && own.json?.code === 'service_protected',
    `${own.status}`,
  );
  const needed = await api('POST', `/system/services/${SSH_UNIT}/stop`);
  check(
    'ssh never stopped',
    needed.status === 403 && needed.json?.code === 'service_protected',
    `${needed.status}`,
  );

  await systemJournal();

  await api('DELETE', '/files/session/sudo');
  sh('gpasswd', ['-d', 'anna', ADMINS]);
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
      `ws://${ADDRESS}:${PORT}/api/terminal?ticket=${ticket.json?.ticket}&cols=80&rows=24`,
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
  const token = readFileSync('/var/lib/ilex/app/setup-token', 'utf8').trim();
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
  check('the web app is served on the same origin', (await page.text()).includes('<ilex-root'));
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
    ['ilex-postgres-1', 'ilex-docker-proxy-1'].every(
      (n) => containers.containers?.find((c) => c.name === n)?.protected,
    ),
    names.join(', '),
  );

  // Before any app task: Ilexarium refuses cleanup for a while after one (an image just pulled for
  // an install looks unused).
  await dockerCleanup();

  // anna's sudo and Lock now first (processes): the apps below need her sudo unlocked again.
  await files();

  console.log('\nApps, as anna (not in the docker group: system units through her sudo)');
  // Taken out of the sudo group above (the "not allowed" check): an administrator again.
  sh('usermod', ['-aG', ADMINS, 'anna']);
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
  // Unlocked again: the installs above may have taken longer than ilex-root's 15 idle minutes.
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
  // Root writes nowhere another account can change: not below bob's home, through anna's sudo.
  ensurePerson('bob', 1501);
  const intoBobs = await api('POST', '/backups/restores', {
    itemId: item?.id,
    archive: archives[0]?.name,
    target: '/home/bob/restored',
  });
  check(
    'a restore below another account’s folder refused at once, nothing made there',
    intoBobs.status === 422 &&
      intoBobs.json?.code === 'path_others_can_change' &&
      !existsSync('/home/bob/restored'),
    `${intoBobs.status} ${intoBobs.text}`,
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

  // As on a new machine: no ~/apps. Borg would make it root's, 0700 — out of her reach.
  console.log('\nBack where it was with ~/apps gone');
  renameSync('/home/anna/apps', '/home/anna/apps-before-smoke');
  const refreshed = await api('POST', '/backups/archives/refresh', {});
  check(
    'the lists read again from the disk, through her sudo',
    refreshed.status === 204,
    `${refreshed.status} ${refreshed.text}`,
  );
  const fromDisk = (await api('GET', `/backups/items/${item?.id}/archives`)).json?.archives ?? [];
  check(
    'its backups as the disk has them',
    fromDisk.length > 0 && fromDisk[0]?.name === archives[0]?.name,
    JSON.stringify(fromDisk),
  );
  const anew = await api('POST', '/backups/restores', {
    itemId: item?.id,
    archive: fromDisk[0]?.name,
    target: null,
  });
  const anewDone = await until(
    'the restore with ~/apps gone finished',
    async () => {
      const r = await api('GET', `/backups/restores/${anew.json?.restoreId}`);
      return { done: r.json?.status && r.json.status !== 'running', value: r.json };
    },
    10 * 60_000,
  );
  const appsFolder = statSync('/home/anna/apps', { throwIfNoEntry: false });
  check(
    'restored, ~/apps made again as hers (0755), the app back in it',
    anewDone.value?.status === 'succeeded' &&
      appsFolder?.uid === 1500 &&
      (appsFolder.mode & 0o777) === 0o755 &&
      existsSync(`${folder}/compose.yml`),
    `${JSON.stringify(anewDone.value).slice(0, 300)} uid ${appsFolder?.uid} mode ${appsFolder && (appsFolder.mode & 0o777).toString(8)}`,
  );
  rmSync('/home/anna/apps-before-smoke', { recursive: true, force: true });

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
  await machineCheck();
  await api('DELETE', '/files/session');

  await profile();
  done();
}

/** The installer's own checks (check_setup) for a person, as the installer prints them. */
async function installerChecks(person) {
  const version = readFileSync('/etc/ilex/version', 'utf8').trim();
  const lib = `/root/ilex-${version}/system/install/lib`;
  // Not synchronous: it takes seconds, and a blocked script finds the app's kept-alive
  // connection closed (its 5 s keep-alive) at the next request.
  const { stdout } = await execFileAsync(
    'bash',
    ['-c', 'set -euo pipefail; . "$1/common.sh"; . "$1/checks.sh"; check_setup', '_', lib],
    {
      encoding: 'utf8',
      // What check_machine and ensure_ssh_server work out before it, in the installer.
      env: {
        ...process.env,
        SUDO_USER: person,
        OS_FAMILY: ADMINS === 'wheel' ? 'pacman' : 'apt',
        SSH_UNIT,
      },
    },
  );
  return stdout;
}

/**
 * The machine check, as bob — signed in, in the docker group,
 * lingering on, no sudo: the page's checks through the API and the installer's; then password
 * logins turned off by a drop-in, and lingering off, each named with what to do.
 */
async function machineCheck() {
  console.log('\nThe machine check (as bob)');
  const person = await api('POST', '/machine-check/person');
  check(
    'the page’s checks: the helper, user units, apps with the docker group',
    person.status === 200 &&
      JSON.stringify(person.json) ===
        JSON.stringify({ helper: 'ok', userUnits: true, lingering: true, docker: 'user_units' }),
    `${person.status} ${person.text}`,
  );
  let out = await installerChecks('bob');
  check(
    'the installer: password logins, lingering and user units pass, no sudo named with its fix',
    out.includes('✓ password logins') &&
      out.includes('✓ lingering on for bob') &&
      out.includes('✓ user units start for bob') &&
      out.includes('✗ bob may not use sudo') &&
      out.includes(`usermod -aG ${ADMINS} bob`),
    out,
  );
  out = await installerChecks('anna');
  check('the installer: anna may use sudo', out.includes('✓ anna may use sudo'), out);

  // A Match block read before ilex.conf's turns password logins off.
  // Alongside, a global "no" (as cloud-init writes): harmless here, so never named.
  const dropin = '/etc/ssh/sshd_config.d/10-smoke-off.conf';
  const harmless = '/etc/ssh/sshd_config.d/05-smoke-global.conf';
  writeFileSync(dropin, 'Match all\n    PasswordAuthentication no\n');
  writeFileSync(harmless, 'PasswordAuthentication no\n');
  sh('systemctl', ['reload', SSH_UNIT]);
  out = await installerChecks('bob');
  check(
    'the installer names the drop-in that turned password logins off',
    out.includes('✗ password logins') && out.includes(dropin) && !out.includes(harmless),
    out,
  );
  const off = await api('POST', '/files/session', {
    username: 'bob',
    password: 'bob-smoke-password',
  });
  check(
    'the sign-in says password logins are off (not a wrong password)',
    off.status === 403 && off.json?.code === 'linux_password_logins_off',
    `${off.status} ${off.text}`,
  );
  rmSync(dropin);
  rmSync(harmless);
  sh('systemctl', ['reload', SSH_UNIT]);

  // Lingering off: named by both, with its fix (user units still start: on demand, in session).
  // Right after the reload sshd may not answer yet (a 503): ask again for a few seconds.
  let signedIn;
  for (let tries = 0; tries < 10; tries++) {
    signedIn = await api('POST', '/files/session', {
      username: 'bob',
      password: 'bob-smoke-password',
    });
    if (signedIn.status !== 503) break;
    await sleep(500);
  }
  sh('loginctl', ['disable-linger', 'bob']);
  const noLinger = await api('POST', '/machine-check/person');
  check(
    'lingering off: the page says so, though user units start in the session',
    signedIn.status === 200 &&
      noLinger.json?.userUnits === true &&
      noLinger.json?.lingering === false,
    `${signedIn.status} ${noLinger.status} ${noLinger.text}`,
  );
  await api('DELETE', '/files/session');
  out = await installerChecks('bob');
  check(
    'lingering off: the installer names it, with its fix',
    out.includes('✗ lingering is off for bob') && out.includes('loginctl enable-linger bob'),
    out,
  );
  sh('loginctl', ['enable-linger', 'bob']);
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
    'ilex-postgres-1',
    'psql',
    '-tA',
    '-U',
    'ilex_owner',
    '-d',
    'ilex',
    '-c',
    "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('Chat', 'ChatMessage')",
  ]).trim();
  check('migrated: the Assistant’s chat tables are gone', chatTables === '0', chatTables);
  check('backups still set up', (await api('GET', '/backups/status')).json?.configured === true);
  check(
    'a database backup was made before migrating',
    sh('ls', ['/var/lib/ilex/install-backups']).trim().length > 0,
  );
  check('the version recorded', existsSync('/etc/ilex/version'));
  if (process.argv[3] === '--installed-again') {
    const version = readFileSync('/etc/ilex/version', 'utf8');
    expect('/opt/ilex/previous', { mode: '0700', uid: 0 });
    check(
      'the installed version kept before it was replaced (the way back)',
      readFileSync('/opt/ilex/previous/VERSION', 'utf8') === version &&
        existsSync('/opt/ilex/previous/app/apps/server/dist/main.js') &&
        existsSync('/opt/ilex/previous/libexec/ilex-root.mts') &&
        existsSync('/opt/ilex/previous/files/etc/ilex/app.env') &&
        existsSync('/opt/ilex/previous/files/etc/systemd/system/ilex.service'),
    );
  }
  await securitySetup();
  await files();
  await profile();
  done();
}

async function selfUpdate(version, expected) {
  console.log(`An update to ${version} by ilex-update (expected: ${expected})`);
  const before = readFileSync('/etc/ilex/version', 'utf8').trim();
  const id = randomUUID();
  const out = sh('/opt/ilex/libexec/ilex-update.mts', ['start'], {
    input: JSON.stringify({ updateId: id, version }),
  });
  check('ilex-update start: its unit started', out.includes('@@result'), out);
  const job = `/var/lib/ilex/updates/${id}.jsonl`;
  const end = await until(
    'the update ended',
    async () => {
      const events = existsSync(job)
        ? readFileSync(job, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
      const result = events.find((event) => event.type === 'done');
      return { done: Boolean(result), value: result ?? events.at(-1) };
    },
    15 * 60_000,
  );
  check(`outcome: ${expected}`, end.value?.outcome === expected, JSON.stringify(end.value));
  const want = expected === 'updated' ? version : before;
  const health = await api('GET', '/health');
  check(
    `${want} installed and answering`,
    readFileSync('/etc/ilex/version', 'utf8').trim() === want && health.json?.version === want,
    `${readFileSync('/etc/ilex/version', 'utf8').trim()} ${health.text}`,
  );
  expect(job, { mode: '0640', uid: 0, gid: gidOf('ilex') });
  check('its download folder is gone', !existsSync(`/var/lib/ilex/updates/${id}`));
  await update();
}

if (process.argv[2] === 'self-update') await selfUpdate(process.argv[3], process.argv[4]);
else if (process.argv[2] === 'recover-cli') await recoverCli();
else if (process.argv[2] === 'recover-app') await recoverApp();
else if (process.argv[2] === 'https') {
  await httpsPort();
  done();
} else await (process.argv[2] === 'update' ? update() : install());

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
    'ilex-docker-proxy-1',
  ]).trim();
  sh('docker', ['volume', 'create', 'smoke_used']);
  sh('docker', ['create', '--name', 'smoke-holder', '-v', 'smoke_used:/x', proxyImage]);
  sh('docker', [
    'volume',
    'create',
    '--label',
    'com.docker.compose.project=ilex',
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

/** How many audit entries of an action the database holds. */
function auditCount(action) {
  return Number(
    sh('docker', [
      'exec',
      'ilex-postgres-1',
      'psql',
      '-tA',
      '-U',
      'ilex_owner',
      '-d',
      'ilex',
      '-c',
      `SELECT count(*) FROM "AuditEvent" WHERE action = '${action}'`,
    ]).trim(),
  );
}

/** What a recovered Ilexarium must have: the owner, the plan, its backups, the settings. */
async function recovered(expectedId) {
  await until(
    'the app answers after the recovery',
    async () => ({ done: (await api('GET', '/health').catch(() => ({}))).status === 200 }),
    3 * 60_000,
  );
  check(
    'set up again (the restored accounts)',
    (await api('GET', '/auth/status')).json?.needsSetup === false,
  );
  await signIn();
  const plan = (await api('GET', '/backups/plan')).json?.plan;
  check(
    'the backup plan is back, on the same disk, navidrome in it',
    plan?.destination === '/mnt/backup' && plan.items.some((i) => i.project === 'navidrome'),
    JSON.stringify(plan).slice(0, 300),
  );
  check('backups configured', (await api('GET', '/backups/status')).json?.configured === true);
  const runs = (await api('GET', '/backups/runs')).json?.runs ?? [];
  check('the backup history is back', runs.length > 0, `${runs.length} runs`);
  expect('/etc/ilex/backup.passphrase', { mode: '0400', uid: 0 });
  expect('/etc/ilex/master.key', { mode: '0400', uid: uidOf('ilex') });
  expect('/var/lib/ilex/backups/recovery.json', { mode: '0640', uid: 0, gid: gidOf('ilex') });
  check(
    'the passphrase is the one from the backup disk',
    readFileSync('/etc/ilex/backup.passphrase', 'utf8').trim() ===
      readFileSync(KEPT_PASSPHRASE, 'utf8').trim(),
  );
  check(
    'the backup timer is on',
    !fails('systemctl', ['is-enabled', '--quiet', 'ilex-backup.timer']),
  );
  check(
    'nothing of the recovery left behind',
    !existsSync('/var/lib/ilex/backups/recover') ||
      sh('ls', ['-A', '/var/lib/ilex/backups/recover']).trim() === '',
  );
  const recovery = (await api('GET', '/backups/recovery')).json?.recovery;
  check(
    'the recovery shown: succeeded, anna (1500) there',
    recovery?.status === 'succeeded' &&
      (!expectedId || recovery.id === expectedId) &&
      recovery.accounts?.some((a) => a.uid === 1500 && a.name === 'anna' && a.here === 'anna'),
    JSON.stringify(recovery).slice(0, 400),
  );
  check('its result audited once', auditCount('backup.recover_result') === 1);
  return recovery;
}

async function recoverCli() {
  console.log('Restoring Ilexarium from the backup disk (ilex-recover)');
  check(
    'a fresh install: needs setup',
    (await api('GET', '/auth/status')).json?.needsSetup === true,
  );
  let out = '';
  try {
    out = sh('/usr/local/sbin/ilex-recover', ['--yes'], {
      input: `${readFileSync(KEPT_PASSPHRASE, 'utf8').trim()}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  check('ilex-recover finished', out.includes('Ilexarium is back'), out.slice(-1500));
  check('it lists the accounts the apps need', /1500 anna — there/.test(out), out.slice(-800));
  check(
    'it never prints the passphrase',
    !out.includes(readFileSync(KEPT_PASSPHRASE, 'utf8').trim()),
  );
  await recovered(null);

  console.log('\nAn app restored back in place, as anna');
  // The checks before leave her out of the administrators (they test both ways).
  sh('usermod', ['-aG', ADMINS, 'anna']);
  await linuxSignIn('anna');
  const sudo = await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  check(
    'anna’s sudo unlocked',
    sudo.status === 200 || sudo.status === 204,
    `${sudo.status} ${sudo.text}`,
  );
  // The check timer, on again, runs its missed check at once: it holds the lock a while (busy).
  await until(
    'the backups read again from the disk',
    async () => {
      const refreshed = await api('POST', '/backups/archives/refresh', {});
      // Spaced out: changes are limited to 20 a minute.
      if (refreshed.status !== 204) await sleep(4000);
      return { done: refreshed.status === 204, value: `${refreshed.status} ${refreshed.text}` };
    },
    10 * 60_000,
  );
  const item = (await api('GET', '/backups/plan')).json?.plan?.items.find(
    (i) => i.project === 'navidrome',
  );
  const archives = (await api('GET', `/backups/items/${item?.id}/archives`)).json?.archives ?? [];
  const back = await api('POST', '/backups/restores', {
    itemId: item?.id,
    archive: archives.at(-1)?.name,
    target: null,
  });
  check('the restore started', back.status === 202, `${back.status} ${back.text}`);
  const restored = await until(
    'the restore finished',
    async () => {
      const r = await api('GET', `/backups/restores/${back.json?.restoreId}`);
      return { done: r.json && r.json.status !== 'running', value: r.json };
    },
    10 * 60_000,
  );
  check(
    'navidrome restored back in place, owned by anna',
    restored.value?.status === 'succeeded' &&
      statSync('/home/anna/apps/navidrome/compose.yml').uid === 1500,
    JSON.stringify(restored.value).slice(0, 300),
  );
  for (const path of restored.value?.setAside ?? []) rmSync(path, { recursive: true, force: true });
  const dismissed = await api('POST', '/backups/recovery/dismiss', {});
  check(
    'the notice dismissed, kept in the database',
    dismissed.status === 204 &&
      (await api('GET', '/backups/recovery')).json?.recovery?.dismissed === true,
  );
  await api('DELETE', '/files/session');
  done();
}

async function recoverApp() {
  console.log('Restoring Ilexarium from the backup disk, through the app');
  check(
    'a fresh install: needs setup',
    (await api('GET', '/auth/status')).json?.needsSetup === true,
  );
  const setupToken = readFileSync('/var/lib/ilex/app/setup-token', 'utf8').trim();
  const throwaway = { username: 'setup', password: 'only for the recovery here' };
  const setup = await api('POST', '/auth/setup', { setupToken, ...throwaway });
  check('a throwaway account', setup.status === 200 || setup.status === 201, setup.text);
  await api('POST', '/auth/login', throwaway);
  sh('usermod', ['-aG', ADMINS, 'anna']);
  await linuxSignIn('anna');
  const sudo = await api('POST', '/files/session/sudo', { password: 'anna-smoke-password' });
  check(
    'anna’s sudo unlocked',
    sudo.status === 200 || sudo.status === 204,
    `${sudo.status} ${sudo.text}`,
  );
  // The disks with backups, as the Disks data shows them (no sudo needed).
  const disks = (await api('GET', '/backups/destinations')).json?.destinations ?? [];
  check(
    'the backup disk listed, holding backups',
    disks.some((d) => d.mountPoint === '/mnt/backup' && d.hasRepository),
    JSON.stringify(disks).slice(0, 300),
  );
  const passphrase = readFileSync(KEPT_PASSPHRASE, 'utf8').trim();
  const wrong = await api('POST', '/backups/recovery/check', {
    repository: REPOSITORY,
    passphrase: 'not the words',
  });
  check(
    'a wrong passphrase refused',
    wrong.status === 422 && wrong.json?.code === 'passphrase_invalid',
    wrong.text,
  );
  const checked = await api('POST', '/backups/recovery/check', {
    repository: REPOSITORY,
    passphrase,
  });
  const archive = checked.json?.archives?.at(-1)?.name;
  check(
    'its newest backup of Ilexarium',
    checked.status === 200 && typeof archive === 'string',
    checked.text,
  );
  const started = await api('POST', '/backups/recovery', {
    repository: REPOSITORY,
    passphrase,
    archive,
  });
  check(
    'the recovery started (its own unit)',
    started.status === 202,
    `${started.status} ${started.text}`,
  );
  // The session goes with the replaced database: a 401, as the web app's wait sees it (/auth/me
  // answers 200 signed out). A failure leaves it, and says so in its file.
  const end = Date.now() + 10 * 60_000;
  let me = { status: 0 };
  while (Date.now() < end) {
    me = await api('GET', '/backups/recovery').catch(() => ({ status: 0 }));
    if (me.status === 401) break;
    const recovery = me.status === 200 ? me.json?.recovery : null;
    if (recovery?.id === started.json?.recoveryId && recovery.status === 'failed') break;
    await sleep(3000);
  }
  if (me.status !== 401) {
    let journal = '';
    try {
      journal = sh('journalctl', [
        '-u',
        `ilex-recover@${started.json?.recoveryId}`,
        '-n',
        '60',
        '--no-pager',
      ]);
    } catch (error) {
      journal = String(error);
    }
    const file = existsSync('/var/lib/ilex/backups/recovery.json')
      ? readFileSync('/var/lib/ilex/backups/recovery.json', 'utf8')
      : 'no recovery.json';
    check(
      'the session gone (the restored database never had it)',
      false,
      `${me.status}\n${file}\n${journal}`,
    );
    done();
  }
  cookie = '';
  await recovered(started.json?.recoveryId);
  const gone = await api('POST', '/auth/login', throwaway);
  check('the throwaway account is gone', gone.status === 401, `${gone.status}`);
  check(
    'the request file with the passphrase is gone',
    !existsSync('/var/lib/ilex/backups/recover-requests') ||
      sh('ls', ['-A', '/var/lib/ilex/backups/recover-requests']).trim() === '',
  );
  done();
}
