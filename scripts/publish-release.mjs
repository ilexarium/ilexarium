// Copies a signed release (release/v<version>/, from release:sign) into a release folder laid
// out like GitHub's (docs/plans/install_and_update.md), and points latest/ at it when it's newer:
//   <folder>/download/v<version>/…   <folder>/latest/download/latest.json(.minisig)   <folder>/get-laris.sh
// Old versions keep their own files. Usage: npm run release:publish -- <folder> [<version>]
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [folder, wanted] = process.argv.slice(2);
if (!folder) {
  console.error('usage: npm run release:publish -- <folder> [<version>]');
  process.exit(2);
}
const version = wanted ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const signed = join(ROOT, 'release', `v${version}`);
if (!existsSync(join(signed, 'manifest.json.minisig'))) {
  console.error(`release/v${version}/ isn't signed (npm run release:sign)`);
  process.exit(1);
}
const target = join(resolve(folder), 'download', `v${version}`);
if (existsSync(target)) {
  console.error(`${target} exists — a published version is never replaced (build a new version)`);
  process.exit(1);
}

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

mkdirSync(join(resolve(folder), 'download'), { recursive: true });
cpSync(signed, `${target}.tmp`, { recursive: true });
renameSync(`${target}.tmp`, target);

const latest = join(resolve(folder), 'latest', 'download');
const current = existsSync(join(latest, 'latest.json'))
  ? JSON.parse(readFileSync(join(latest, 'latest.json'), 'utf8')).version
  : '0.0.0';
if (newer(version, current)) {
  mkdirSync(latest, { recursive: true });
  // Each swapped in whole; a reader between the two renames gets a pair that fails its check and
  // tries again later.
  copyFileSync(join(target, 'manifest.json.minisig'), join(latest, 'latest.json.minisig.tmp'));
  copyFileSync(join(target, 'manifest.json'), join(latest, 'latest.json.tmp'));
  renameSync(join(latest, 'latest.json.minisig.tmp'), join(latest, 'latest.json.minisig'));
  renameSync(join(latest, 'latest.json.tmp'), join(latest, 'latest.json'));
  const getLaris = join(ROOT, 'release', 'get-laris.sh');
  if (existsSync(getLaris)) copyFileSync(getLaris, join(resolve(folder), 'get-laris.sh'));
  console.log(`Published ${version} as the latest`);
} else {
  console.log(`Published ${version} (the latest stays ${current})`);
}
