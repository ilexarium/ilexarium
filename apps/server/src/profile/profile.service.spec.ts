import { readFileSync } from 'node:fs';
import { PROFILE_LIMITS, type PublicUser } from '@homelab/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { UsersService } from '../users/users.service.js';
import { ProfileService } from './profile.service.js';

const USER: PublicUser = {
  id: 'u1',
  username: 'owner',
  createdAt: '2026-10-20T00:00:00.000Z',
  displayName: null,
  email: null,
  language: null,
  avatar: null,
};
const actor = { user: USER, ip: '127.0.0.1' };
const file = (name: string) => readFileSync(new URL(`./testdata/${name}`, import.meta.url));

function setup() {
  const users = {
    updateProfile: vi.fn(async () => USER),
    setAvatar: vi.fn(async () => USER),
    removeAvatar: vi.fn(async () => USER),
  };
  const audit = { tryRecord: vi.fn(async () => undefined) };
  const service = new ProfileService(
    users as unknown as UsersService,
    audit as unknown as AuditService,
  );
  return { service, users, audit };
}

describe('ProfileService', () => {
  describe('update', () => {
    it('saves only the given fields; an empty name or address removes it', async () => {
      const { service, users } = setup();
      await service.update({ displayName: '', email: 'anna@example.com' }, actor);
      expect(users.updateProfile).toHaveBeenCalledWith('u1', {
        displayName: null,
        email: 'anna@example.com',
      });
      await service.update({ language: 'ar' }, actor);
      expect(users.updateProfile).toHaveBeenLastCalledWith('u1', { language: 'ar' });
    });

    it('audits the names of the changed fields, never their values', async () => {
      const { service, audit } = setup();
      await service.update({ displayName: 'Anna', email: 'anna@example.com' }, actor);
      expect(audit.tryRecord).toHaveBeenCalledWith({
        action: 'profile.update',
        outcome: 'success',
        userId: 'u1',
        username: 'owner',
        ip: '127.0.0.1',
        details: { fields: ['displayName', 'email'] },
      });
      expect(JSON.stringify(audit.tryRecord.mock.calls)).not.toContain('anna@example.com');
    });
  });

  describe('setAvatar', () => {
    it.each([
      ['canvas-600.webp', 'image/webp'],
      ['canvas-600.jpg', 'image/jpeg'],
      ['canvas-600.png', 'image/png'],
    ])('keeps %s as %s — the type its bytes show', async (name, type) => {
      const { service, users, audit } = setup();
      const bytes = file(name);
      await service.setAvatar(bytes, actor);
      expect(users.setAvatar).toHaveBeenCalledWith('u1', bytes, type);
      expect(audit.tryRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'profile.avatar',
          details: { change: 'set', type, bytes: bytes.length },
        }),
      );
    });

    it.each([
      ['a picture that isn’t 600×600', file('canvas-599x600.webp')],
      ['a GIF', file('red-600.gif')],
      ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"/>')],
      ['nothing', Buffer.alloc(0)],
    ])('refuses %s with invalid_picture, keeping nothing', async (_name, bytes) => {
      const { service, users } = setup();
      await expect(service.setAvatar(bytes, actor)).rejects.toMatchObject({
        status: 400,
        response: { code: 'invalid_picture' },
      });
      expect(users.setAvatar).not.toHaveBeenCalled();
    });

    it('refuses more than pictureMaxBytes with picture_too_large', async () => {
      const { service, users } = setup();
      const big = Buffer.concat([
        file('canvas-600.png'),
        Buffer.alloc(PROFILE_LIMITS.pictureMaxBytes),
      ]);
      await expect(service.setAvatar(big, actor)).rejects.toMatchObject({
        status: 413,
        response: { code: 'picture_too_large' },
      });
      expect(users.setAvatar).not.toHaveBeenCalled();
    });
  });

  it('removes the picture and audits it', async () => {
    const { service, users, audit } = setup();
    await service.removeAvatar(actor);
    expect(users.removeAvatar).toHaveBeenCalledWith('u1');
    expect(audit.tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'profile.avatar', details: { change: 'removed' } }),
    );
  });
});
