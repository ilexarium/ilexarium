import { OperationSlot } from './operation-slot.js';

describe('OperationSlot', () => {
  it('holds one operation at a time, and says which', () => {
    const slot = new OperationSlot();
    const release = slot.claim('deploy');
    expect(slot.current()).toBe('deploy');
    expect(() => slot.claim('restore')).toThrow(
      expect.objectContaining({ status: 409, response: expect.objectContaining({ code: 'busy' }) }),
    );
    release();
    release(); // twice is harmless: it must not free someone else's claim
    const next = slot.claim('backup');
    release();
    expect(slot.current()).toBe('backup');
    next();
    expect(slot.current()).toBeNull();
  });

  it('counts a scheduled backup run the app only follows', () => {
    const slot = new OperationSlot();
    let running = true;
    slot.followExternal(() => (running ? 'backup' : null));
    expect(slot.current()).toBe('backup');
    expect(() => slot.claim('deploy')).toThrow(expect.objectContaining({ status: 409 }));
    running = false;
    expect(() => slot.claim('deploy')).not.toThrow();
  });

  it('tells listeners when it is taken and freed', () => {
    const slot = new OperationSlot();
    const listener = vi.fn();
    slot.changes$.subscribe(listener);
    slot.claim('remove')();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
