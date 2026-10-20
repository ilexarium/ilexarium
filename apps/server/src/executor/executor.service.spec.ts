import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { JobPhase, PublicUser } from '@homelab/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import type { Env } from '../config/env.schema.js';
import type { ComposeRequest } from './executor.model.js';
import { ExecutorService } from './executor.service.js';
import type {
  BackupWrapperAction,
  DiskWrapperAction,
  WrapperAction,
  WrapperCommand,
} from './wrapper-command.js';
import type { WrapperConfigService } from './wrapper-config.js';

const USER: PublicUser = {
  id: 'u1',
  username: 'owner',
  createdAt: '2026-10-12T00:00:00.000Z',
  displayName: null,
  email: null,
  language: null,
  avatar: null,
};

/**
 * A stand-in for the wrapper: records its arguments, environment and stdin, then prints the
 * lines of script.json and exits with its code (after `sleep` ms).
 */
const FAKE_WRAPPER = `
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ args: process.argv.slice(2), env: process.env, stdin }));
const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
if (script.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, script.sleep);
for (const line of script.lines) process.stdout.write(line + '\\n');
process.exit(script.exit ?? 0);
`;

let dir: string;
let audit: { record: ReturnType<typeof vi.fn>; tryRecord: ReturnType<typeof vi.fn> };
let entries: AuditEntry[];

class TestExecutor extends ExecutorService {
  file = process.execPath;
  override timeoutMs = 10_000;
  protected override command(action: WrapperAction, catalogId: string): WrapperCommand {
    return {
      file: this.file,
      args: [join(dir, 'wrapper.cjs'), action, catalogId],
      env: { PATH: '/usr/bin:/bin' },
    };
  }
  protected override backupCommand(action: BackupWrapperAction): WrapperCommand {
    return {
      file: this.file,
      args: [join(dir, 'wrapper.cjs'), action],
      env: { PATH: '/usr/bin:/bin' },
    };
  }
  protected override processCommand(): WrapperCommand {
    return {
      file: this.file,
      args: [join(dir, 'wrapper.cjs'), 'signal'],
      env: { PATH: '/usr/bin:/bin' },
    };
  }
  override diskTimeoutMs = 10_000;
  protected override diskCommand(action: DiskWrapperAction): WrapperCommand {
    return {
      file: this.file,
      args: [join(dir, 'wrapper.cjs'), action],
      env: { PATH: '/usr/bin:/bin' },
    };
  }
}

function executor(): TestExecutor {
  const config = { get: () => 'direct' } as unknown as ConfigService<Env, true>;
  const wrapperConfig = { file: '/unused' } as unknown as WrapperConfigService;
  return new TestExecutor(config, audit as unknown as AuditService, wrapperConfig);
}

function script(lines: string[], exit = 0, sleep = 0) {
  writeFileSync(join(dir, 'script.json'), JSON.stringify({ lines, exit, sleep }));
}

function record(): { args: string[]; env: Record<string, string>; stdin: string } {
  return JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
}

function request(change: Partial<ComposeRequest> = {}) {
  const phases: JobPhase[] = [];
  const output: string[] = [];
  const req: ComposeRequest = {
    catalogId: 'immich',
    serviceId: 's1',
    values: { WEB_PORT: 2283, DB_PASSWORD: 'Secret0Secret0Secret0' },
    secrets: ['Secret0Secret0Secret0'],
    fields: ['WEB_PORT', 'UPLOAD_DIR', 'DB_PASSWORD'],
    actor: { user: USER, ip: '127.0.0.1' },
    audit: { settings: { WEB_PORT: 2283 } },
    onPhase: (phase) => phases.push(phase),
    onOutput: (line) => output.push(line),
    ...change,
  };
  return { req, phases, output };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'executor-'));
  writeFileSync(join(dir, 'wrapper.cjs'), FAKE_WRAPPER);
  entries = [];
  audit = {
    record: vi.fn(async (entry: AuditEntry) => void entries.push(entry)),
    tryRecord: vi.fn(async (entry: AuditEntry) => void entries.push(entry)),
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ExecutorService', () => {
  it('runs the wrapper with the values on stdin — never in its arguments — and reports phases and output', async () => {
    script(['@@phase pulling', '> Pulling immich-server', '@@phase starting', '@@phase done']);
    const { req, phases, output } = request();
    expect(await executor().composeUp(req)).toEqual({ ok: true });
    const { args, stdin } = record();
    expect(args).toEqual(['up', 'immich']);
    expect(JSON.parse(stdin)).toEqual({ WEB_PORT: 2283, DB_PASSWORD: 'Secret0Secret0Secret0' });
    expect(phases).toEqual(['pulling', 'starting', 'done']);
    expect(output).toEqual(['Pulling immich-server']);
  });

  it('gives down nothing on stdin', async () => {
    script(['@@phase removing', '@@phase done']);
    const { req } = request({ values: undefined });
    expect(await executor().composeDown(req)).toEqual({ ok: true });
    expect(record()).toMatchObject({ args: ['down', 'immich'], stdin: '' });
  });

  it('masks every secret in the output', async () => {
    script([
      '> error: password Secret0Secret0Secret0 refused',
      '@@info DB_PASSWORD=Secret0Secret0Secret0',
    ]);
    const { req, output } = request();
    await executor().composeUp(req);
    expect(output).toEqual(['error: password •••• refused', 'DB_PASSWORD=••••']);
  });

  it('records the request first, then the outcome (never secrets)', async () => {
    script(['@@phase done']);
    await executor().composeUp(request().req);
    expect(entries.map((e) => [e.action, e.outcome])).toEqual([
      ['service.deploy', 'requested'],
      ['service.deploy', 'success'],
    ]);
    expect(audit.record).toHaveBeenCalledTimes(1); // the request: the call that fails closed
    expect(entries[0]).toMatchObject({
      userId: 'u1',
      username: 'owner',
      ip: '127.0.0.1',
      details: { catalogId: 'immich', serviceId: 's1', settings: { WEB_PORT: 2283 } },
    });
    expect(JSON.stringify(entries)).not.toContain('Secret0');
  });

  it('runs nothing when the request can’t be recorded', async () => {
    script(['@@phase done']);
    audit.record.mockRejectedValueOnce(new Error('database down'));
    await expect(executor().composeUp(request().req)).rejects.toThrow('database down');
    expect(existsSync(join(dir, 'record.json'))).toBe(false);
  });

  it.each([
    [['@@error code=port_in_use field=WEB_PORT'], 2, { code: 'port_in_use', field: 'WEB_PORT' }],
    [
      ['@@error code=path_not_allowed field=UPLOAD_DIR'],
      2,
      { code: 'path_not_allowed', field: 'UPLOAD_DIR' },
    ],
    [['@@error code=busy'], 3, { code: 'busy', field: null }],
    [['@@error code=policy_violation'], 4, { code: 'policy_violation', field: null }],
    [
      ['@@phase starting', '@@error code=compose_failed'],
      5,
      { code: 'compose_failed', field: null },
    ],
    // A field the entry doesn't have is dropped, never passed on.
    [['@@error code=invalid_values field=NOT_A_FIELD'], 2, { code: 'invalid_values', field: null }],
    // Codes we don't know are a setup problem, never success.
    [['@@error code=setup'], 6, { code: 'executor_unavailable', field: null }],
    [['@@error code=constructor'], 6, { code: 'executor_unavailable', field: null }],
    [['@@error code=to_string'], 6, { code: 'executor_unavailable', field: null }],
    // No marker at all: the wrapper never ran (e.g. sudo: a password is required).
    [['sudo: a password is required'], 1, { code: 'executor_unavailable', field: null }],
    [['@@phase pulling'], 1, { code: 'compose_failed', field: null }],
  ])('turns %j (exit %i) into a typed failure', async (lines, exit, failure) => {
    script(lines, exit);
    const outcome = await executor().composeUp(request().req);
    expect(outcome).toEqual({ ok: false, ...failure });
    expect(entries.at(-1)).toMatchObject({ outcome: 'failure', details: { reason: failure.code } });
  });

  it('reports a wrapper that can’t be started as unavailable', async () => {
    script([]);
    const ex = executor();
    ex.file = join(dir, 'no-such-program');
    expect(await ex.composeUp(request().req)).toEqual({
      ok: false,
      code: 'executor_unavailable',
      field: null,
    });
  });

  it('stops the wrapper when it takes too long', async () => {
    script(['@@phase pulling'], 0, 5000);
    const ex = executor();
    ex.timeoutMs = 300;
    expect(await ex.composeUp(request().req)).toEqual({
      ok: false,
      code: 'timed_out',
      field: null,
    });
  });
});

describe('ExecutorService backups', () => {
  const actor = { user: USER, ip: '127.0.0.1' };

  it('sends the input on stdin, the action as the only argument, and reads the result', async () => {
    script(['@@result {"repositoryId":"abc","created":true}']);
    expect(await executor().backupInit('/mnt/usb', actor)).toEqual({
      ok: true,
      result: { repositoryId: 'abc', created: true },
    });
    expect(record()).toMatchObject({ args: ['init'], stdin: '{"destination":"/mnt/usb"}' });
    expect(entries.map((e) => [e.action, e.outcome])).toEqual([
      ['backup.init', 'requested'],
      ['backup.init', 'success'],
    ]);
  });

  it('hands the passphrase to the caller only — never to output or the audit log', async () => {
    script(['@@result {"passphrase":"alpha beta gamma delta epsilon zeta"}']);
    const outcome = await executor().backupPassphrase(actor, 'show');
    expect(outcome).toEqual({
      ok: true,
      result: { passphrase: 'alpha beta gamma delta epsilon zeta' },
    });
    expect(record().stdin).toBe('');
    expect(JSON.stringify(entries)).not.toContain('alpha');
  });

  it('never passes a result line to the job output', async () => {
    script([
      '@@phase restoring',
      '> extracting',
      '@@result {"targetPath":null,"setAside":["/srv/x.before-restore-20261014-030000"]}',
      '@@phase done',
    ]);
    const phases: string[] = [];
    const output: string[] = [];
    const outcome = await executor().backupRestore(
      { restoreId: 'r', itemId: 'i', archive: 'a', target: 'inPlace' },
      actor,
      { onPhase: (p) => phases.push(p), onOutput: (l) => output.push(l) },
    );
    expect(outcome).toEqual({
      ok: true,
      result: { targetPath: null, setAside: ['/srv/x.before-restore-20261014-030000'] },
    });
    expect(phases).toEqual(['restoring', 'done']);
    expect(output).toEqual(['extracting']);
  });

  it('reads a result longer than an output line, whole', async () => {
    const setAside = Array.from(
      { length: 60 },
      (_, i) =>
        `/srv/homelab/${'a-rather-long-folder-name-'.repeat(4)}${i}.before-restore-20261014-030000`,
    );
    const line = `@@result ${JSON.stringify({ targetPath: null, setAside })}`;
    expect(line.length).toBeGreaterThan(4096);
    script([line, '@@phase done']);
    const outcome = await executor().backupRestore(
      { restoreId: 'r', itemId: 'i', archive: 'a', target: 'inPlace' },
      actor,
      { onPhase: () => undefined, onOutput: () => undefined },
    );
    expect(outcome).toEqual({ ok: true, result: { targetPath: null, setAside } });
  });

  it('starts "Back up now" and returns at once: the run is systemd\'s, not a child of the app', async () => {
    script(['@@result {"started":true}']);
    expect(await executor().backupStart({ runId: 'r1', itemId: 'i1' }, actor)).toEqual({
      ok: true,
      result: null,
    });
    script(['@@error code=item_not_found'], 2);
    expect(await executor().backupStart({ runId: 'r1' }, actor)).toMatchObject({
      ok: false,
      code: 'backup_item_not_found',
    });
  });

  it('maps refusals, keeping a result that was still printed', async () => {
    script(
      [
        '@@result {"targetPath":null,"setAside":["/srv/a.before-restore-20261014-030000"]}',
        '@@error code=service_not_restarted',
      ],
      5,
    );
    const outcome = await executor().backupRestore(
      { restoreId: 'r', itemId: 'i', archive: 'a', target: 'inPlace' },
      actor,
      { onPhase: () => undefined, onOutput: () => undefined },
    );
    expect(outcome).toEqual({
      ok: false,
      code: 'service_not_restarted',
      result: { targetPath: null, setAside: ['/srv/a.before-restore-20261014-030000'] },
    });
    script(['@@error code=destination_unavailable'], 5);
    expect(await executor().backupInit('/mnt/usb', actor)).toMatchObject({
      ok: false,
      code: 'destination_unavailable',
    });
    script(['@@error code=constructor'], 2);
    expect(await executor().backupForget('i', actor)).toMatchObject({
      ok: false,
      code: 'executor_unavailable',
    });
  });

  it('counts an action without a result as done when it exits 0', async () => {
    script(['@@phase done']);
    expect(await executor().backupDiscard('/srv/x.before-restore-20261014-030000', actor)).toEqual({
      ok: true,
      result: null,
    });
    script(['@@phase done'], 0);
    // An action that must print a result and didn't: not done.
    expect(await executor().backupPassphrase(actor, 'show')).toMatchObject({ ok: false });
  });

  it('does nothing when the audit log can’t record the request', async () => {
    script(['@@phase done']);
    audit.record.mockRejectedValueOnce(new Error('no audit table'));
    await expect(
      executor().backupConfigure(
        {
          destination: '/mnt/x',
          schedule: { frequency: 'daily', time: '03:00' },
          retention: { daily: 7, weekly: 4, monthly: 6 },
          items: [],
        },
        actor,
      ),
    ).rejects.toThrow();
    expect(existsSync(join(dir, 'record.json'))).toBe(false);
  });
});

describe('ExecutorService disks', () => {
  const actor = { user: USER, ip: '127.0.0.1' };

  it('mounts: the values on stdin, the action the only argument, audited before and after', async () => {
    script(['@@phase mounting', '@@result {"mountPoint":"/mnt/photos"}']);
    expect(await executor().diskMount({ uuid: '4E21-9A07', name: 'photos' }, actor)).toEqual({
      ok: true,
      result: { mountPoint: '/mnt/photos' },
    });
    expect(record()).toMatchObject({
      args: ['mount'],
      stdin: '{"uuid":"4E21-9A07","name":"photos"}',
    });
    expect(entries.map((e) => [e.action, e.outcome, e.details])).toEqual([
      ['disk.mount', 'requested', { uuid: '4E21-9A07', name: 'photos' }],
      ['disk.mount', 'success', { uuid: '4E21-9A07', name: 'photos' }],
    ]);
  });

  it('unmounts, and maps the wrapper’s refusals — an unknown one as unavailable', async () => {
    script(['@@phase done']);
    expect(await executor().diskUnmount('photos', actor)).toEqual({ ok: true, result: null });
    expect(record()).toMatchObject({ args: ['unmount'], stdin: '{"name":"photos"}' });

    script(['@@error code=disk_busy'], 3);
    expect(await executor().diskUnmount('photos', actor)).toEqual({ ok: false, code: 'disk_busy' });
    expect(entries.at(-1)).toMatchObject({
      action: 'disk.unmount',
      outcome: 'failure',
      details: { name: 'photos', reason: 'disk_busy' },
    });
    script(['@@error code=constructor'], 2);
    expect(await executor().diskUnmount('photos', actor)).toEqual({
      ok: false,
      code: 'executor_unavailable',
    });
    // A mount that printed no result isn't done, whatever its exit code.
    script(['@@phase mounting']);
    expect(await executor().diskMount({ uuid: 'u', name: 'x' }, actor)).toMatchObject({
      ok: false,
    });
  });

  it('stops a mount that takes too long', async () => {
    script(['@@phase mounting'], 0, 2_000);
    const slow = executor();
    (slow as unknown as { diskTimeoutMs: number }).diskTimeoutMs = 100;
    expect(await slow.diskMount({ uuid: 'u', name: 'x' }, actor)).toEqual({
      ok: false,
      code: 'timed_out',
    });
  });

  it('does nothing when the audit log can’t record the request', async () => {
    script(['@@phase done']);
    audit.record.mockRejectedValueOnce(new Error('no audit table'));
    await expect(executor().diskUnmount('photos', actor)).rejects.toThrow();
    expect(existsSync(join(dir, 'record.json'))).toBe(false);
  });
});

describe('ExecutorService processes', () => {
  const actor = { user: USER, ip: '127.0.0.1' };
  const request = { pid: 4312, startTicks: '5000', signal: 'TERM' as const };
  const names = { name: 'python3', user: 'anna' };

  it('signals: the request on stdin, `signal` the only argument, audited without the command line', async () => {
    script(['@@result {"signalled":true}']);
    expect(await executor().processSignal(request, names, actor)).toEqual({ ok: true });
    expect(record()).toMatchObject({
      args: ['signal'],
      stdin: '{"pid":4312,"startTicks":"5000","signal":"TERM"}',
    });
    const details = { pid: 4312, name: 'python3', user: 'anna', signal: 'TERM' };
    expect(entries.map((e) => [e.action, e.outcome, e.details])).toEqual([
      ['process.end', 'requested', details],
      ['process.end', 'success', details],
    ]);
  });

  it('maps the wrapper’s refusals; an unknown one, or no result, is no success', async () => {
    script(['@@error code=process_protected'], 2);
    expect(await executor().processSignal(request, names, actor)).toEqual({
      ok: false,
      code: 'process_protected',
    });
    expect(entries.at(-1)).toMatchObject({
      outcome: 'failure',
      details: { pid: 4312, reason: 'process_protected' },
    });
    script(['@@error code=process_not_found'], 2);
    expect(await executor().processSignal(request, names, actor)).toEqual({
      ok: false,
      code: 'process_not_found',
    });
    script(['@@error code=whatever'], 2);
    expect(await executor().processSignal(request, names, actor)).toEqual({
      ok: false,
      code: 'executor_unavailable',
    });
    script([], 0);
    expect(await executor().processSignal(request, names, actor)).toEqual({
      ok: false,
      code: 'executor_unavailable',
    });
  });

  it('does nothing when the audit log can’t record the request', async () => {
    script(['@@result {"signalled":true}']);
    audit.record.mockRejectedValueOnce(new Error('no audit table'));
    await expect(executor().processSignal(request, names, actor)).rejects.toThrow();
    expect(existsSync(join(dir, 'record.json'))).toBe(false);
  });
});
