// The install test's other versions of a built release (tools/vm/test-install.sh): the same
// archive under a new version, written beside it as release/ilex-<version>.tar.gz —
//   node repack-release.mjs <archive> <version> [--broken]
// --broken: an app that never starts (the update must roll back).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const [archive, version, flag] = process.argv.slice(2);
if (!archive || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node repack-release.mjs <archive> <version> [--broken]');
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), 'ilex-repack-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', work]);
  const old = basename(archive).replace(/\.tar\.gz$/, '');
  const stage = join(work, `ilex-${version}`);
  renameSync(join(work, old), stage);
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);
  const pkg = join(stage, 'app/package.json');
  writeFileSync(
    pkg,
    `${JSON.stringify({ ...JSON.parse(readFileSync(pkg, 'utf8')), version }, null, 2)}\n`,
  );
  if (flag === '--broken') {
    writeFileSync(join(stage, 'app/apps/server/dist/main.js'), 'process.exit(1);\n');
  }
  const out = join(dirname(archive), `ilex-${version}.tar.gz`);
  execFileSync('tar', [
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    out,
    '-C',
    work,
    `ilex-${version}`,
  ]);
  console.log(out);
} finally {
  rmSync(work, { recursive: true, force: true });
}
