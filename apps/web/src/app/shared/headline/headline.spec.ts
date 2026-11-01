import { headline } from './headline';

describe('headline', () => {
  it('says what needs attention first, then all running or how many', () => {
    expect(headline('apps.headline', 3, 1, 2)).toEqual({
      key: 'apps.headline.attention',
      count: 1,
      total: 3,
    });
    expect(headline('apps.headline', 3, 0, 3).key).toBe('apps.headline.allRunning');
    expect(headline('apps.headline', 3, 0, 2)).toEqual({
      key: 'apps.headline.someRunning',
      count: 2,
      total: 3,
    });
  });
});
