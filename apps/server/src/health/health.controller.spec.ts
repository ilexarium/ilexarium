import { readFileSync } from 'node:fs';
import { healthResponseSchema } from '@laris/shared';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns a response matching the shared contract', () => {
    const result = new HealthController().check();
    expect(healthResponseSchema.safeParse(result).success).toBe(true);
  });

  it('says which Laris runs: the root package’s version', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    );
    expect(new HealthController().check().version).toBe(root.version);
  });
});
