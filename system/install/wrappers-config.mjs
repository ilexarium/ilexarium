// The root programs' configuration (/etc/ilex/wrappers.json): system/config/wrappers.json with
// this machine's values in place of its nulls. Run by the installer as root:
//   APP_UID=… APP_GID=… BORG_BIN=… SSH_UNIT=… node wrappers-config.mjs <template>
import { readFileSync } from 'node:fs';

const fail = (message) => {
  process.stderr.write(`wrappers-config: ${message}\n`);
  process.exit(1);
};

const id = (name) => {
  const value = process.env[name] ?? '';
  if (!/^\d+$/.test(value)) fail(`${name} isn't a number: ${value}`);
  return Number(value);
};
const absolutePath = (name) => {
  const value = process.env[name] ?? '';
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.split('/').includes('..')) {
    fail(`${name} isn't a plain absolute path: ${value}`);
  }
  return value;
};
const oneOf = (name, allowed) => {
  const value = process.env[name] ?? '';
  if (!allowed.includes(value)) fail(`${name} isn't one of ${allowed.join(', ')}: ${value}`);
  return value;
};

const [templatePath] = process.argv.slice(2);
if (!templatePath) fail('no template');
const config = JSON.parse(readFileSync(templatePath, 'utf8'));
const appGid = id('APP_GID');
config.update.appGid = appGid;
config.update.sshUnit = oneOf('SSH_UNIT', ['ssh.service', 'sshd.service']);
config.backup.borgBin = absolutePath('BORG_BIN');
config.backup.appUid = id('APP_UID');
config.backup.appGid = appGid;

// A machine value added to the template must be filled here too.
const empty = (value) =>
  value === null || (typeof value === 'object' && Object.values(value).some(empty));
if (empty(config)) fail(`a value of the template is still empty: ${templatePath}`);
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
