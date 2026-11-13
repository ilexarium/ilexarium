// What `npm run verify` records and what `npm run ship` accepts. Run by the server's unit tests.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notRecordable, readStamp, unverified, withPassed, writeStamp } from './verified.mjs';

const HEAD = '1111111111111111111111111111111111111111';
const OLDER = '2222222222222222222222222222222222222222';
const AT = '2026-11-13T12:00:00Z';

const passedAt = (commit: string) =>
  Object.fromEntries(
    ['lint', 'format', 'unit', 'e2e', 'install'].map((part) => [part, { commit, at: AT }]),
  );

describe('unverified (what ship refuses)', () => {
  it('names every part when verify never ran', () => {
    expect(unverified({}, HEAD)).toEqual([
      { part: 'lint', passedAt: null },
      { part: 'format', passedAt: null },
      { part: 'unit', passedAt: null },
      { part: 'e2e', passedAt: null },
      { part: 'install', passedAt: null },
    ]);
  });

  it('accepts a commit at which every part passed', () => {
    expect(unverified(passedAt(HEAD), HEAD)).toEqual([]);
  });

  it('names the parts that last passed at another commit', () => {
    const stamp = { ...passedAt(HEAD), e2e: { commit: OLDER, at: AT } };
    expect(unverified(stamp, HEAD)).toEqual([{ part: 'e2e', passedAt: OLDER }]);
  });

  it('refuses everything once a new commit is made', () => {
    expect(unverified(passedAt(OLDER), HEAD).map((entry) => entry.part)).toEqual([
      'lint',
      'format',
      'unit',
      'e2e',
      'install',
    ]);
  });

  it('names a part missing from the record', () => {
    const { install: _, ...stamp } = passedAt(HEAD);
    expect(unverified(stamp, HEAD)).toEqual([{ part: 'install', passedAt: null }]);
  });
});

describe('notRecordable (when verify may vouch for a commit)', () => {
  it('records a run on a clean tree that stayed at one commit', () => {
    expect(
      notRecordable({ commit: HEAD, clean: true }, { commit: HEAD, clean: true }),
    ).toBeUndefined();
  });

  it('records nothing for a tree with changes when the run started', () => {
    expect(notRecordable({ commit: HEAD, clean: false }, { commit: HEAD, clean: true })).toBe(
      'the working tree has changes that are not committed',
    );
  });

  it('records nothing when files changed during the run', () => {
    expect(notRecordable({ commit: HEAD, clean: true }, { commit: HEAD, clean: false })).toBe(
      'the working tree has changes that are not committed',
    );
  });

  it('records nothing when another commit was checked out during the run', () => {
    expect(notRecordable({ commit: OLDER, clean: true }, { commit: HEAD, clean: true })).toBe(
      `the commit changed during the run (${OLDER} → ${HEAD})`,
    );
  });
});

describe('the record', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ilex-verified-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads as empty when there is none', () => {
    expect(readStamp(join(dir, 'verified.json'))).toEqual({});
  });

  it('reads as empty when it is not JSON', () => {
    writeFileSync(join(dir, 'verified.json'), 'not json');
    expect(readStamp(join(dir, 'verified.json'))).toEqual({});
  });

  it('reads back what was written, its folder made on the way', () => {
    const file = join(dir, '.dev', 'verified.json');
    writeStamp(file, passedAt(HEAD));
    expect(readStamp(file)).toEqual(passedAt(HEAD));
  });

  it('keeps the other parts when one passes', () => {
    const stamp = withPassed({ lint: { commit: OLDER, at: AT } }, 'unit', HEAD, AT);
    expect(stamp).toEqual({ lint: { commit: OLDER, at: AT }, unit: { commit: HEAD, at: AT } });
    expect(unverified(stamp, HEAD).map((entry) => entry.part)).toEqual([
      'lint',
      'format',
      'e2e',
      'install',
    ]);
  });
});
