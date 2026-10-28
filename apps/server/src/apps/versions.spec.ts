import { orderVersions } from './versions.js';

describe('orderVersions', () => {
  it('newest first, wider lines above their patches, plain before variants; moving and pre-releases left out', () => {
    expect(
      orderVersions([
        'latest',
        '1.2.3',
        '1.10.0',
        '1.2',
        '1',
        'v2.0.0-rc1',
        '1.2.3-alpine',
        'nightly',
        'develop',
        'sha-1a2b3c',
        'amd64-1.2.3',
        '2.0.0-beta.1',
        '0.9',
      ]),
    ).toEqual(['1', '1.10.0', '1.2', '1.2.3', '1.2.3-alpine', '0.9']);
  });

  it('keeps v-prefixed versions in order', () => {
    expect(orderVersions(['v1.2.0', 'v1.10.1', 'v3'])).toEqual(['v3', 'v1.10.1', 'v1.2.0']);
  });
});
