// node driver.mjs <ip> <label> [--wait] [--docker] [--no-p] — run by run.sh
import { createRequire } from 'node:module';
const { Client } = createRequire(new URL('../../../package.json', import.meta.url))('ssh2');
const [ip, label, ...flags] = process.argv.slice(2);
const results = [];
// Older sudo-rs refuses -p.
const PROMPT = flags.includes('--no-p') ? [] : ['-p', ''];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(user) {
  return new Promise((res, rej) => {
    const c = new Client();
    c.on('ready', () => res(c))
      .on('error', rej)
      .connect({ host: ip, username: user, password: `${user}-pw`, readyTimeout: 20000 });
  });
}
function execPlain(c, cmd) {
  return new Promise((res, rej) =>
    c.exec(cmd, (err, ch) => {
      if (err) return rej(err);
      let out = '';
      ch.on('data', (d) => (out += d)).stderr.on('data', (d) => (out += d));
      ch.on('close', (code) => res({ code, out }));
    }),
  );
}
function helper(c) {
  return new Promise((res, rej) =>
    c.exec('node /opt/proto/helper.mjs', { pty: { term: 'dumb' } }, (err, ch) => {
      if (err) return rej(err);
      let buf = '',
        id = 0;
      const waiting = new Map();
      let ready;
      ch.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (!line.startsWith('{')) {
            if (line.trim()) console.log('# helper said: ' + line);
            continue;
          }
          const msg = JSON.parse(line);
          if (msg.ready) ready?.(msg);
          else waiting.get(msg.id)?.(msg);
        }
      });
      let closed = null;
      ch.on('close', (code, signal) => {
        closed = `helper channel closed (code ${code}, signal ${signal}); last output: ${JSON.stringify(buf.slice(-300))}`;
        console.log('# ' + closed);
        for (const r of waiting.values()) r({ code: -1, stdout: '', stderr: closed });
        waiting.clear();
      });
      ready = () =>
        res({
          run: (argv, stdin) =>
            new Promise((r) => {
              if (closed) return r({ code: -1, stdout: '', stderr: closed });
              const n = ++id;
              const t = setTimeout(() => {
                waiting.delete(n);
                r({ code: -1, stdout: '', stderr: `timeout: ${argv.join(' ')}` });
              }, 30000);
              waiting.set(n, (m) => {
                clearTimeout(t);
                r(m);
              });
              ch.write(JSON.stringify({ id: n, argv, stdin }) + '\n');
            }),
          close: () => ch.close(),
        });
    }),
  );
}
const okRun = (r) => r.code === 0;

const alice1 = await connect('alice');
const h1 = await helper(alice1);
const ttyName = (await h1.run(['sh', '-c', 'readlink /proc/$PPID/fd/0'])).stdout.trim();
console.log(
  `# ${label}: helper on ${ttyName}; sudo: ${(await h1.run(['sudo', '-V'])).stdout.split('\n')[0]}`,
);

check('no cache before: sudo -n fails', !okRun(await h1.run(['sudo', '-n', 'true'])));
const v = await h1.run(['sudo', '-S', ...PROMPT, '-v'], 'wrong\n');
check('wrong password refused', !okRun(v), v.stderr.trim().split('\n').pop());
const v2 = await h1.run(['sudo', '-S', ...PROMPT, '-v'], 'alice-pw\n');
check('sudo -S -v with the password', okRun(v2), v2.stderr.trim());
const id0 = await h1.run(['sudo', '-n', 'id', '-u']);
check(
  'then sudo -n in the same helper',
  okRun(id0) && id0.stdout.trim() === '0',
  id0.stderr.trim(),
);
const l = await h1.run(['sudo', '-n', '-l']);
console.log(
  '# sudo -n -l defaults: ' + (l.stdout.match(/timestamp[^,\n]*/g) ?? ['(none shown)']).join(', '),
);

const h1b = await helper(alice1);
check(
  'another pty channel on the same connection: no cache',
  !okRun(await h1b.run(['sudo', '-n', 'true'])),
);
h1b.close();
const alice2 = await connect('alice');
const h2 = await helper(alice2);
check('another connection with a pty: no cache', !okRun(await h2.run(['sudo', '-n', 'true'])));
check('a command without a pty: no cache', (await execPlain(alice2, 'sudo -n true')).code !== 0);
const user = await h1.run(['systemd-run', '--user', '--wait', '--quiet', 'sudo', '-n', 'true']);
check('a user unit: no cache', !okRun(user), user.stderr.trim());

// Long tasks: user unit (journal + file), system unit through sudo -n; then close every connection.
await execPlain(alice2, 'rm -f ~/task.log');
const u = await h1.run([
  'systemd-run',
  '--user',
  '--unit=proto-task',
  '--collect',
  '-p',
  'StandardOutput=append:/home/alice/task.log',
  'sh',
  '-c',
  'for i in $(seq 1 40); do echo tick $i; sleep 1; done',
]);
check('systemd-run --user starts', okRun(u), u.stderr.trim());
const uj = await h1.run([
  'systemd-run',
  '--user',
  '--unit=proto-journal',
  '--collect',
  'sh',
  '-c',
  'for i in $(seq 1 40); do echo jtick $i; sleep 1; done',
]);
check('systemd-run --user (journal) starts', okRun(uj), uj.stderr.trim());
const s = await h1.run([
  'sudo',
  '-n',
  'systemd-run',
  '--unit=proto-root',
  '--collect',
  '-p',
  'StandardOutput=append:/tmp/root-task.log',
  'sh',
  '-c',
  'for i in $(seq 1 40); do echo root $(id -u) $i; sleep 1; done',
]);
check('sudo -n systemd-run (a system unit) starts', okRun(s), s.stderr.trim());
h1.close();
h2.close();
alice1.end();
alice2.end();
await sleep(6000);

const alice3 = await connect('alice');
const h3 = await helper(alice3);
const tty3 = (await h3.run(['sh', '-c', 'readlink /proc/$PPID/fd/0'])).stdout.trim();
check(
  `new session after closing (${tty3}, before ${ttyName}): no cache`,
  !okRun(await h3.run(['sudo', '-n', 'true'])),
);
check(
  'user unit survives the closed session',
  (await h3.run(['systemctl', '--user', 'is-active', 'proto-task'])).stdout.trim() === 'active',
);
const tl = await h3.run(['tail', '-n', '1', '/home/alice/task.log']);
check(
  'its output file grows',
  /tick (\d+)/.test(tl.stdout) && Number(tl.stdout.match(/tick (\d+)/)[1]) > 5,
  tl.stdout.trim(),
);
const j = await h3.run([
  'journalctl',
  '--user',
  '-u',
  'proto-journal',
  '--no-pager',
  '-n',
  '2',
  '-o',
  'cat',
]);
check(
  'user journal readable by the person',
  /jtick/.test(j.stdout),
  (j.stdout + j.stderr).trim().replace(/\n/g, ' | '),
);
const jf = await h3.run([
  'timeout',
  '3',
  'journalctl',
  '--user',
  '-u',
  'proto-journal',
  '-f',
  '-n',
  '0',
  '-o',
  'cat',
]);
check(
  'user journal can be followed',
  /jtick/.test(jf.stdout),
  (jf.stdout + jf.stderr).trim().replace(/\n/g, ' | ').slice(0, 120),
);
check(
  'system unit (through sudo) survives',
  /root 0 \d+/.test((await h3.run(['tail', '-n', '1', '/tmp/root-task.log'])).stdout),
);

await h3.run(['sudo', '-S', ...PROMPT, '-v'], 'alice-pw\n');
await h3.run(['sudo', '-k']);
check('sudo -k ends the cache', !okRun(await h3.run(['sudo', '-n', 'true'])));

if (flags.includes('--wait')) {
  // Needs "Defaults:alice timestamp_timeout=1" in the machine.
  await h3.run(['sudo', '-S', ...PROMPT, '-v'], 'alice-pw\n');
  await sleep(40000);
  check('timeout 1 min: valid at 40 s', okRun(await h3.run(['sudo', '-n', 'true'])));
  await sleep(40000);
  check(
    'used at 40 s: still valid at 80 s (use refreshes it)',
    okRun(await h3.run(['sudo', '-n', 'true'])),
  );
  await sleep(70000);
  check('unused for 70 s: expired', !okRun(await h3.run(['sudo', '-n', 'true'])));
}

if (flags.includes('--docker')) {
  const compose = 'services:\n  hello:\n    image: busybox:1.37\n    command: ["sleep", "600"]\n';
  const bob = await connect('bob');
  const hb = await helper(bob);
  await hb.run(['mkdir', '-p', '/home/bob/apps/hello']);
  await hb.run(['tee', '/home/bob/apps/hello/compose.yml'], compose);
  const up = await hb.run([
    'systemd-run',
    '--user',
    '--wait',
    '--quiet',
    '--unit=laris-app-hello-install',
    '--working-directory=/home/bob/apps/hello',
    '-p',
    'StandardOutput=append:/home/bob/apps/hello/install.log',
    '-p',
    'StandardError=append:/home/bob/apps/hello/install.log',
    'docker',
    'compose',
    'up',
    '-d',
  ]);
  check(
    'docker group: compose up as a user unit',
    okRun(up),
    (up.stderr + (await hb.run(['tail', '-n', '3', '/home/bob/apps/hello/install.log'])).stdout)
      .trim()
      .replace(/\n/g, ' | '),
  );
  const ps = await hb.run([
    'docker',
    'ps',
    '--filter',
    'label=com.docker.compose.project=hello',
    '--format',
    '{{.Label "com.docker.compose.project.working_dir"}} {{.State}}',
  ]);
  check(
    'its working_dir label',
    (ps.stdout ?? '').includes('/home/bob/apps/hello running'),
    ps.stdout.trim(),
  );
  hb.close();
  bob.end();

  const a = await connect('alice');
  const ha = await helper(a);
  await ha.run(['mkdir', '-p', '/home/alice/apps/hi']);
  await ha.run(['tee', '/home/alice/apps/hi/compose.yml'], compose);
  check('not in the docker group: docker refused', !okRun(await ha.run(['docker', 'ps'])));
  await ha.run(['sudo', '-S', ...PROMPT, '-v'], 'alice-pw\n');
  const sup = await ha.run([
    'sudo',
    '-n',
    'systemd-run',
    '--wait',
    '--quiet',
    '--unit=laris-app-hi-install',
    '--working-directory=/home/alice/apps/hi',
    'docker',
    'compose',
    'up',
    '-d',
  ]);
  check('through sudo: compose up as a system unit', okRun(sup), sup.stderr.trim());
  const ps2 = await ha.run([
    'sudo',
    '-n',
    'docker',
    'ps',
    '--filter',
    'label=com.docker.compose.project=hi',
    '--format',
    '{{.State}}',
  ]);
  check(
    'its container runs',
    (ps2.stdout ?? '').trim() === 'running',
    (ps2.stdout ?? '') + (ps2.stderr ?? ''),
  );
  ha.close();
  a.end();
}
alice3.end();
const failed = results.filter((r) => !r.ok).length;
console.log(`# ${label}: ${results.length - failed} passed, ${failed} failed`);
process.exit(0);
