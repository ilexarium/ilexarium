// Builds a release archive for the installer (docs/plans/installer.md):
//   release/homelab-<version>.tar.gz and its .sha256
// holding the built server and web app, their production packages (one archive for amd64 and
// arm64: no native modules, and Prisma's migration engine for both), the migrations, the catalog
// and system/ (the installer, wrappers, units). Usage: npm run release
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version ${version} isn't x.y.z`);
const NAME = `homelab-${version}`;
const OUT = join(ROOT, 'release');
const STAGE = join(OUT, NAME);
const APP = join(STAGE, 'app');
/** Prisma's migration engine for the CPUs the installer supports (all three distributions ship OpenSSL 3). */
const ENGINE_TARGETS = ['debian-openssl-3.0.x', 'linux-arm64-openssl-3.0.x'];

const run = (command, args, cwd = ROOT) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } });
const copy = (from, to, filter) => cpSync(join(ROOT, from), to, { recursive: true, filter });

console.log(`Building ${NAME}`);
run('npm', ['run', 'build:shared']);
run('npm', ['run', 'build', '-w', '@homelab/server']);
run('npm', ['run', 'build', '-w', '@homelab/web']);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

// The app, laid out like the repository (the workspace links in node_modules point at packages/).
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
writeFileSync(
  join(APP, 'package.json'),
  `${JSON.stringify({ name: packageJson.name, version, private: true, type: 'module', workspaces: packageJson.workspaces }, null, 2)}\n`,
);
copy('package-lock.json', join(APP, 'package-lock.json'));
for (const pkg of ['packages/shared', 'packages/i18n']) {
  mkdirSync(join(APP, pkg), { recursive: true });
  copy(`${pkg}/package.json`, join(APP, pkg, 'package.json'));
  copy(`${pkg}/dist`, join(APP, pkg, 'dist'));
  if (existsSync(join(ROOT, pkg, 'messages'))) copy(`${pkg}/messages`, join(APP, pkg, 'messages'));
}
const server = join(APP, 'apps/server');
mkdirSync(server, { recursive: true });
copy('apps/server/package.json', join(server, 'package.json'));
copy('apps/server/dist', join(server, 'dist'));
copy('apps/server/prisma', join(server, 'prisma'));
copy('apps/server/prisma.config.ts', join(server, 'prisma.config.ts'));
// The web app: its built files (served by the server, WEB_ROOT), and its package.json only so the
// lockfile's workspaces match — none of its packages are installed.
mkdirSync(join(APP, 'apps/web'), { recursive: true });
copy('apps/web/package.json', join(APP, 'apps/web/package.json'));
copy('apps/web/dist/web/browser', join(APP, 'apps/web/browser'));

// Production packages of the server and what it uses, exactly as locked; no install scripts
// (Prisma's would download one engine for this machine only — both are fetched below).
run(
  'npm',
  [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '-w',
    '@homelab/server',
    '-w',
    '@homelab/shared',
    '-w',
    '@homelab/i18n',
  ],
  APP,
);

// Prisma's migration engine for both CPUs, checksums checked by Prisma's own downloader.
const require = createRequire(join(ROOT, 'apps/server/package.json'));
const { download } = require('@prisma/fetch-engine');
const { enginesVersion } = require('@prisma/engines-version');
const engines = join(APP, 'node_modules/@prisma/engines');
await download({
  binaries: { 'schema-engine': engines },
  binaryTargets: ENGINE_TARGETS,
  version: enginesVersion,
  showProgress: false,
});
for (const target of ENGINE_TARGETS) {
  if (!existsSync(join(engines, `schema-engine-${target}`))) {
    throw new Error(`Prisma's schema engine for ${target} is missing`);
  }
}

// One archive for both CPUs: no compiled Node modules may be in it.
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory()) yield* files(path);
    else if (stat) yield path;
  }
}
const native = [...files(join(APP, 'node_modules'))].filter((path) => path.endsWith('.node'));
if (native.length > 0) {
  throw new Error(
    `Native modules would tie the archive to one CPU:\n${native.map((p) => relative(APP, p)).join('\n')}`,
  );
}

// The catalog, and system/ without the wrappers' tests.
copy('catalog', join(STAGE, 'catalog'));
copy(
  'system',
  join(STAGE, 'system'),
  (src) => !/\.spec\.ts$|\/testing(\/|$)|tsconfig\.json$/.test(src),
);
copy('system/install/install.sh', join(STAGE, 'install.sh'));
writeFileSync(join(STAGE, 'VERSION'), `${version}\n`);

// The archive: owned by root inside, so unpacking it as root keeps nothing of this machine's users.
const archive = join(OUT, `${NAME}.tar.gz`);
run('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', OUT, NAME]);
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${sha256}  ${NAME}.tar.gz\n`);
console.log(`\n${relative(ROOT, archive)}\nsha256 ${sha256}`);
console.log(`${dirname(relative(ROOT, archive))}/${NAME}.tar.gz.sha256`);
