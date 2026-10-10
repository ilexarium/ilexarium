import { healthResponseSchema } from '@homelab/shared';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns a response matching the shared contract', () => {
    const result = new HealthController().check();
    expect(healthResponseSchema.safeParse(result).success).toBe(true);
  });
});
