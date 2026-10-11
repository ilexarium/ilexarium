/** Keeps the last `capacity` items; the oldest drops out when a new one arrives. */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private start = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('capacity must be a positive integer');
    }
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.items.slice(this.start), ...this.items.slice(0, this.start)];
  }

  clear(): void {
    this.items.length = 0;
    this.start = 0;
  }
}
