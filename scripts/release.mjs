// Builds a release archive for the installer (docs/plans/installer.md):
//   release/ilex-<version>.tar.gz and its .sha256
// holding the built server and web app, their production packages (one archive for amd64 and
// arm64: no native modules, and Prisma's migration engine for both), the migrations, the catalog
// and system/ (the installer, the root programs and the helper, units).
//
//   RELEASE_URL=https://… npm run release
//
// RELEASE_URL is where this release's updates come from (docs/plans/install_and_update.md); with
// it, the public key (RELEASE_PUB, by default system/install/release.pub) goes into the release
// and release/get-ilex.sh is written for that address. Without both, the release can't update
// itself (tests).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version ${version} isn't x.y.z`);
const NAME = `ilex-${version}`;
const OUT = join(ROOT, 'release');
const STAGE = join(OUT, NAME);
const APP = join(STAGE, 'app');
/** Prisma's migration engine for the CPUs the installer supports (all three distributions ship OpenSSL 3). */
const ENGINE_TARGETS = ['debian-openssl-3.0.x', 'linux-arm64-openssl-3.0.x'];

const releaseUrl = process.env.RELEASE_URL?.replace(/\/+$/, '');
const releasePub = process.env.RELEASE_PUB ?? join(ROOT, 'system/install/release.pub');
// Written into a shell script and a settings file: plain characters only.
if (releaseUrl && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~-]+)*$/.test(releaseUrl)) {
  throw new Error(`RELEASE_URL ${releaseUrl} isn't a plain https:// address`);
}
if (releaseUrl && !existsSync(releasePub)) {
  throw new Error(
    `RELEASE_URL is set, but there's no public key at ${releasePub} (npm run release:key)`,
  );
}
const publicKeyLine = releaseUrl ? readFileSync(releasePub, 'utf8').split('\n')[1] : undefined;
if (releaseUrl && !/^[A-Za-z0-9+/]{56}$/.test(publicKeyLine ?? '')) {
  throw new Error(`${releasePub} isn't a minisign public key`);
}

const run = (command, args, cwd = ROOT) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } });
const copy = (from, to, filter) => cpSync(join(ROOT, from), to, { recursive: true, filter });

console.log(`Building ${NAME}`);
run('npm', ['run', 'build:shared']);
// The templates' rules are checked by their tests, not at startup: a bad template never ships.
run('npx', ['vitest', 'run', 'src/catalog/catalog.spec.ts'], join(ROOT, 'apps/server'));
run('npm', ['run', 'build', '-w', '@ilex/server']);
run('npm', ['run', 'build', '-w', '@ilex/web']);

rmSync(STAGE, { recursive: true, force: true });
rmSync(join(OUT, 'get-ilex.sh'), { force: true });
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
    '@ilex/server',
    '-w',
    '@ilex/shared',
    '-w',
    '@ilex/i18n',
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
    // Links (the workspaces' in node_modules/@ilex) aren't followed: their targets are walked
    // where they are.
    const stat = lstatSync(path);
    if (stat.isDirectory()) yield* files(path);
    else if (stat.isFile()) yield path;
  }
}
const native = [...files(join(APP, 'node_modules'))].filter((path) => path.endsWith('.node'));
if (native.length > 0) {
  throw new Error(
    `Native modules would tie the archive to one CPU:\n${native.map((p) => relative(APP, p)).join('\n')}`,
  );
}

// The catalog, and system/ without the programs' tests.
copy('catalog', join(STAGE, 'catalog'));
copy(
  'system',
  join(STAGE, 'system'),
  (src) => !/\.spec\.ts$|\/testing(\/|$)|tsconfig\.json$|get-ilex\.sh$|release\.pub$/.test(src),
);
copy('system/install/install.sh', join(STAGE, 'install.sh'));
// The GPL travels with every copy.
copy('LICENSE', join(STAGE, 'LICENSE'));
writeFileSync(join(STAGE, 'VERSION'), `${version}\n`);
if (releaseUrl) {
  writeFileSync(join(STAGE, 'release.env'), `RELEASE_URL=${releaseUrl}\n`);
  cpSync(releasePub, join(STAGE, 'release.pub'));
  const getIlex = readFileSync(join(ROOT, 'system/install/get-ilex.sh'), 'utf8')
    .replace("RELEASE_URL='@RELEASE_URL@'", `RELEASE_URL='${releaseUrl}'`)
    .replace("PUBLIC_KEY='@PUBLIC_KEY@'", `PUBLIC_KEY='${publicKeyLine}'`);
  writeFileSync(join(OUT, 'get-ilex.sh'), getIlex, { mode: 0o755 });
} else {
  console.warn('No RELEASE_URL: this release will not find updates by itself.');
}

// The archive: owned by root inside, so unpacking it as root keeps nothing of this machine's users.
const archive = join(OUT, `${NAME}.tar.gz`);
run('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', OUT, NAME]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const sha256 = hash.digest('hex');
writeFileSync(`${archive}.sha256`, `${sha256}  ${NAME}.tar.gz\n`);
console.log(`\n${relative(ROOT, archive)}\nsha256 ${sha256}`);
console.log(`${dirname(relative(ROOT, archive))}/${NAME}.tar.gz.sha256`);
