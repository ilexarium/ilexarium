import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('keeps items oldest first until full', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.toArray()).toEqual([1, 2]);
    expect(buffer.size).toBe(2);
  });

  it('drops the oldest once full, keeping the order', () => {
    const buffer = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) buffer.push(i);
    expect(buffer.toArray()).toEqual([5, 6, 7]);
    expect(buffer.size).toBe(3);
  });

  it('knows its newest item, also after wrapping around', () => {
    const buffer = new RingBuffer<number>(3);
    expect(buffer.last()).toBeUndefined();
    for (let i = 1; i <= 5; i++) {
      buffer.push(i);
      expect(buffer.last()).toBe(i);
    }
  });

  it('starts over after clear', () => {
    const buffer = new RingBuffer<number>(2);
    for (let i = 1; i <= 3; i++) buffer.push(i);
    buffer.clear();
    buffer.push(9);
    expect(buffer.toArray()).toEqual([9]);
  });

  it('returns a copy', () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.toArray().push(99);
    expect(buffer.toArray()).toEqual([1]);
  });

  it('refuses a capacity that is not a positive integer', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      expect(() => new RingBuffer(capacity), String(capacity)).toThrow(RangeError);
    }
  });
});
