import { readRecoveryRecord } from './backup-recovery-record.js';

const record = {
  id: '0193a000-0000-7000-8000-0000000000aa',
  status: 'succeeded',
  errorCode: null,
  archive: '0193a000-0000-7000-8000-000000000001-2026-11-26T03:00:00',
  archiveTime: '2026-11-26T03:00:00.000Z',
  repository: '/mnt/usb/ilex-backups',
  askedBy: 1000,
  startedAt: '2026-11-27T10:00:00.000Z',
  finishedAt: '2026-11-27T10:01:00.000Z',
  accounts: [{ uid: 1500, name: 'anna', items: ['navidrome'] }],
};

describe('readRecoveryRecord', () => {
  it('reads the backup program’s recovery.json', () => {
    expect(readRecoveryRecord(JSON.stringify(record))).toMatchObject({
      id: record.id,
      status: 'succeeded',
      accounts: record.accounts,
    });
    expect(readRecoveryRecord(JSON.stringify({ ...record, accounts: null }))?.accounts).toBeNull();
  });

  it('refuses anything else: not JSON, another shape, values out of range', () => {
    expect(readRecoveryRecord('not json')).toBeNull();
    expect(readRecoveryRecord(JSON.stringify({ ...record, status: 'done' }))).toBeNull();
    expect(readRecoveryRecord(JSON.stringify({ ...record, askedBy: -1 }))).toBeNull();
    expect(readRecoveryRecord(JSON.stringify({ ...record, archive: 'x' }))).toBeNull();
    expect(readRecoveryRecord(JSON.stringify({ ...record, id: undefined }))).toBeNull();
  });
});
