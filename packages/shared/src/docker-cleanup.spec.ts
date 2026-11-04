import { describe, expect, it } from 'vitest';
import { volumeNameSchema, volumeParamsSchema, volumePath } from './docker-cleanup.js';

describe('volumeNameSchema', () => {
  it('accepts Docker’s volume names, named and anonymous', () => {
    for (const name of ['navidrome_data', 'immich-db.1', 'a1', 'f'.repeat(64)]) {
      expect(volumeNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('refuses anything that could leave the URL path or add a query', () => {
    for (const name of [
      '',
      'a',
      '_x',
      '.x',
      '-x',
      '../x',
      'a/b',
      'a?force=1',
      'a b',
      'a%2Fb',
      'x'.repeat(256),
    ]) {
      expect(volumeNameSchema.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('volumeParamsSchema', () => {
  it('takes the name and nothing else', () => {
    expect(volumeParamsSchema.parse({ name: 'music_cache' })).toEqual({ name: 'music_cache' });
    expect(volumeParamsSchema.safeParse({ name: 'music_cache', force: 'true' }).success).toBe(
      false,
    );
  });
});

describe('volumePath', () => {
  it('builds the delete path', () => {
    expect(volumePath('music_cache')).toBe('/api/docker/cleanup/volumes/music_cache');
  });
});
