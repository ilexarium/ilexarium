import { describe, expect, it } from 'vitest';
import { SERVICES_PATH, servicePath } from './services.js';

describe('service paths', () => {
  it('put the encoded id in the path', () => {
    expect(SERVICES_PATH).toBe('/api/services');
    expect(servicePath('0192f3a1-7c2e-7a4b-9d1e-3f5a7c9b2d4e')).toBe(
      '/api/services/0192f3a1-7c2e-7a4b-9d1e-3f5a7c9b2d4e',
    );
    expect(servicePath('a/../b')).toBe('/api/services/a%2F..%2Fb');
  });
});
