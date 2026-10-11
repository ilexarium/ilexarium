import { safeReturnUrl } from './return-url';

describe('safeReturnUrl', () => {
  it.each(['/', '/settings/account', '/services?tab=logs', '/a/b#c'])('keeps %s', (path) => {
    expect(safeReturnUrl(path)).toBe(path);
  });

  it.each([
    null,
    undefined,
    '',
    'settings',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
  ])('falls back to / for %s', (value) => {
    expect(safeReturnUrl(value)).toBe('/');
  });
});
