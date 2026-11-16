// Tests for lib/ownership.mts: who else could change a path. Run by the server's unit tests.
import { mkdtempSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askingUid, groupHasOthers, othersCanChange } from './lib/ownership.mts';

let dir: string;
let files: { passwd: string; group: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ownership-'));
  files = { passwd: join(dir, 'passwd'), group: join(dir, 'group') };
  writeFileSync(
    files.passwd,
    [
      'root:x:0:0:root:/root:/bin/bash',
      'anna:x:1000:1000::/home/anna:/bin/bash',
      'bob:x:1001:1001::/home/bob:/bin/bash',
      'carl:x:1002:100::/home/carl:/bin/bash',
    ].join('\n'),
  );
  writeFileSync(
    files.group,
    ['root:x:0:', 'users:x:100:', 'anna:x:1000:', 'bob:x:1001:anna', 'media:x:2000:anna,bob'].join(
      '\n',
    ),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stat = (fields: Partial<{ uid: number; gid: number; mode: number; link: boolean }>) =>
  ({
    uid: fields.uid ?? 1000,
    gid: fields.gid ?? 1000,
    mode: fields.mode ?? 0o40755,
    isSymbolicLink: () => fields.link ?? false,
  }) as unknown as Stats;

describe('groupHasOthers', () => {
  it('a private group holds only its owner; a shared one, or one that is another’s own, others', () => {
    expect(groupHasOthers(1000, 1000, files)).toBe(false);
    // anna is listed in bob's group: bob is in it as its own.
    expect(groupHasOthers(1001, 1001, files)).toBe(true);
    expect(groupHasOthers(2000, 1000, files)).toBe(true);
    // carl's own group is `users`: anyone else whose own group it is counts.
    expect(groupHasOthers(100, 1000, files)).toBe(true);
    expect(groupHasOthers(0, 0, files)).toBe(false);
  });

  it('files it can’t read: assume others', () => {
    expect(groupHasOthers(1000, 1000, { passwd: join(dir, 'none'), group: files.group })).toBe(
      true,
    );
  });
});

describe('othersCanChange', () => {
  it('the asker’s or root’s, written only by them: no', () => {
    expect(othersCanChange(stat({}), 1000, false)).toBe(false);
    expect(othersCanChange(stat({ uid: 0, gid: 0 }), 1000, false)).toBe(false);
  });

  it('a link, another owner, or written by others: yes', () => {
    expect(othersCanChange(stat({ link: true }), 1000, false)).toBe(true);
    expect(othersCanChange(stat({ uid: 1001 }), 1000, false)).toBe(true);
    expect(othersCanChange(stat({ mode: 0o40757 }), 1000, false)).toBe(true);
  });

  it('a sticky folder of root’s only further up (/tmp)', () => {
    const tmp = stat({ uid: 0, gid: 0, mode: 0o41777 });
    expect(othersCanChange(tmp, 1000, true)).toBe(false);
    expect(othersCanChange(tmp, 1000, false)).toBe(true);
    expect(othersCanChange(stat({ uid: 1000, mode: 0o41777 }), 1000, true)).toBe(true);
  });
});

describe('askingUid', () => {
  it('not root: this account', () => {
    expect(askingUid()).toBe(process.getuid?.());
  });
});
