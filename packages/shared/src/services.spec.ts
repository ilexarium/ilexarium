import { describe, expect, it } from 'vitest';
import { catalogIdOfProject, servicePath, serviceProject, SERVICES_PATH } from './services.js';

describe('service paths', () => {
  it('put the encoded id in the path', () => {
    expect(SERVICES_PATH).toBe('/api/services');
    expect(servicePath('0192f3a1-7c2e-7a4b-9d1e-3f5a7c9b2d4e')).toBe(
      '/api/services/0192f3a1-7c2e-7a4b-9d1e-3f5a7c9b2d4e',
    );
    expect(servicePath('a/../b')).toBe('/api/services/a%2F..%2Fb');
  });
});

describe('service projects', () => {
  it('names a service’s Compose project, and reads the catalog id back', () => {
    expect(serviceProject('immich')).toBe('hl-immich');
    expect(catalogIdOfProject('hl-immich')).toBe('immich');
  });

  it('gives no catalog id for other projects, a bare prefix or none', () => {
    expect(catalogIdOfProject('laris')).toBeNull();
    expect(catalogIdOfProject('hl-')).toBeNull();
    expect(catalogIdOfProject(null)).toBeNull();
  });
});
