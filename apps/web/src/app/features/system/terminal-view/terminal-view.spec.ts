import { controlCharacter } from './terminal-view';

describe('controlCharacter (the phone key bar’s Ctrl)', () => {
  it.each([
    ['c', '\x03'],
    ['C', '\x03'],
    ['d', '\x04'],
    ['z', '\x1a'],
    ['[', '\x1b'],
    ['@', '\x00'],
  ])('Ctrl+%s', (key, expected) => expect(controlCharacter(key)).toBe(expected));

  it('none for other keys and pasted text', () => {
    expect(controlCharacter('1')).toBeNull();
    expect(controlCharacter('ls')).toBeNull();
  });
});
