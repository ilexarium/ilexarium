import type { ConfigService } from '@nestjs/config';
import type { HttpException } from '@nestjs/common';
import type { PublicUser } from '@laris/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditEntry } from '../audit/audit.model.js';
import type { Env } from '../config/env.schema.js';
import type { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { HelperAnswer, HelperRequest } from '../linux-sessions/linux-sessions.model.js';
import type { ProgramConfigService } from './program-config.js';
import { RootPrograms } from './root-programs.js';

const USER = { id: 'u1', username: 'owner' } as PublicUser;
const ACTOR = { user: USER, ip: '127.0.0.1', appSessionId: 's1' };

let entries: AuditEntry[];
let asked: { request: HelperRequest; options: unknown }[];
let answer: HelperAnswer;
let recordFails: boolean;

function programs(): RootPrograms {
  const audit = {
    record: vi.fn(async (entry: AuditEntry) => {
      if (recordFails) throw new Error('down');
      entries.push(entry);
    }),
    tryRecord: vi.fn(async (entry: AuditEntry) => void entries.push(entry)),
  } as unknown as AuditService;
  const linuxSessions = {
    ask: vi.fn(async (_id: string, request: HelperRequest, options: unknown) => {
      asked.push({ request, options });
      return answer;
    }),
  } as unknown as LinuxSessions;
  const config = { get: () => 'sudo' } as unknown as ConfigService<Env, true>;
  return new RootPrograms(config, audit, { file: '/unused' } as ProgramConfigService, linuxSessions);
}

const ran = (output: string[], code = 0): HelperAnswer => ({ ok: true, code, output: output.join('\n') });

beforeEach(() => {
  entries = [];
  asked = [];
  recordFails = false;
  answer = ran(['@@result {"repositoryId":"abc","created":true}']);
});

describe('RootPrograms (through the person’s sudo)', () => {
  it('asks their helper for `sudo -n <program> <action>`, the input on stdin, audited before and after', async () => {
    const outcome = await programs().backupInit('/mnt/usb', ACTOR);
    expect(outcome).toEqual({ ok: true, result: { repositoryId: 'abc', created: true } });
    expect(asked[0].request).toEqual({
      action: 'root.run',
      program: 'backup',
      command: 'init',
      input: JSON.stringify({ destination: '/mnt/usb' }),
      timeoutMs: expect.any(Number),
    });
    expect(asked[0].options).toMatchObject({ sudo: true });
    expect(entries.map((e) => [e.action, e.outcome])).toEqual([
      ['backup.init', 'requested'],
      ['backup.init', 'success'],
    ]);
  });

  it('runs nothing when the request can’t be recorded', async () => {
    recordFails = true;
    await expect(programs().backupInit('/mnt/usb', ACTOR)).rejects.toMatchObject({
      response: { code: 'audit_unavailable' },
    });
    expect(asked).toEqual([]);
  });

  it('a locked sudo is the Linux side’s 403 sudo_required, recorded as a failure', async () => {
    answer = { ok: false, error: 'sudo_required' };
    const error = (await programs()
      .backupStart({ runId: 'r1' }, ACTOR)
      .catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ code: 'sudo_required' });
    expect(entries.at(-1)).toMatchObject({ outcome: 'failure', details: { reason: 'sudo_required' } });
  });

  it('hands the passphrase to the caller only — never to the audit log', async () => {
    answer = ran(['@@result {"passphrase":"one two three four five six"}']);
    const outcome = await programs().backupPassphrase(ACTOR, 'show');
    expect(outcome).toEqual({ ok: true, result: { passphrase: 'one two three four five six' } });
    expect(JSON.stringify(entries)).not.toContain('one two');
  });

  it('maps the program’s refusals; an unknown one, or none at all, is never success', async () => {
    answer = ran(['@@info another operation is running', '@@error code=busy'], 3);
    expect(await programs().backupStart({ runId: 'r1' }, ACTOR)).toEqual({
      ok: false,
      code: 'busy',
      result: null,
    });
    answer = ran(['@@error code=constructor'], 2);
    expect(await programs().backupStart({ runId: 'r1' }, ACTOR)).toMatchObject({
      code: 'program_unavailable',
    });
    answer = ran(['> something'], 5);
    expect(await programs().backupStart({ runId: 'r1' }, ACTOR)).toMatchObject({
      code: 'borg_failed',
    });
    answer = { ok: false, error: 'timed_out' };
    expect(await programs().backupStart({ runId: 'r1' }, ACTOR)).toMatchObject({
      code: 'timed_out',
    });
    expect(entries.filter((e) => e.outcome === 'failure')).toHaveLength(4);
  });

  it('counts an action without a result as done when it exits 0', async () => {
    answer = ran(['@@phase done']);
    expect(await programs().backupStart({ runId: 'r1' }, ACTOR)).toEqual({ ok: true, result: null });
  });

  it('mounts with the owner of the top folder on stdin, audited without it', async () => {
    answer = ran(['@@result {"mountPoint":"/home/anna/disk"}']);
    const outcome = await programs().diskMount(
      { uuid: 'u-1', mountPoint: '/home/anna/disk', owner: { uid: 1500, gid: 1500 } },
      ACTOR,
    );
    expect(outcome).toEqual({ ok: true, result: { mountPoint: '/home/anna/disk' } });
    expect(JSON.parse((asked[0].request as { input: string }).input)).toEqual({
      uuid: 'u-1',
      mountPoint: '/home/anna/disk',
      owner: { uid: 1500, gid: 1500 },
    });
    expect(entries[0].details).toEqual({ uuid: 'u-1', mountPoint: '/home/anna/disk', mine: true });
  });

  it('unmounts by the mount point; maps the disk program’s codes', async () => {
    answer = ran(['@@error code=used_for_backups field=mountPoint'], 2);
    expect(await programs().diskUnmount('/mnt/usb', ACTOR)).toEqual({
      ok: false,
      code: 'used_for_backups',
    });
    expect(asked[0].request).toMatchObject({ program: 'disk', command: 'unmount' });
  });
});
