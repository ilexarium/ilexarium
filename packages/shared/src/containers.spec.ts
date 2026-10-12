import { describe, expect, it } from 'vitest';
import { containerActionParamsSchema } from './containers.js';

describe('containerActionParamsSchema', () => {
  it('accepts the three actions on a container name', () => {
    for (const action of ['start', 'stop', 'restart']) {
      expect(containerActionParamsSchema.parse({ name: 'jellyfin', action })).toEqual({
        name: 'jellyfin',
        action,
      });
    }
  });

  it('refuses any other action', () => {
    for (const action of ['kill', 'pause', 'remove', 'exec', 'update', 'START', '', 'start/']) {
      expect(
        containerActionParamsSchema.safeParse({ name: 'jellyfin', action }).success,
        action,
      ).toBe(false);
    }
  });

  it('refuses names that could leave the path', () => {
    for (const name of ['../json', 'a/../../b', '/jellyfin', 'a?x=1', '']) {
      expect(containerActionParamsSchema.safeParse({ name, action: 'stop' }).success, name).toBe(
        false,
      );
    }
  });

  it('refuses extra parameters', () => {
    expect(
      containerActionParamsSchema.safeParse({ name: 'jellyfin', action: 'stop', t: '0' }).success,
    ).toBe(false);
  });
});
