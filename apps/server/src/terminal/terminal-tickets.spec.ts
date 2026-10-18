import { TerminalTickets } from './terminal-tickets.js';

describe('TerminalTickets', () => {
  it('good once, for the app session that asked, for 30 seconds', () => {
    const tickets = new TerminalTickets();
    const a = tickets.issue('s1', 0);
    expect(tickets.take(a, 's1', 29_999)).toBe(true);
    expect(tickets.take(a, 's1', 30_000)).toBe(false); // used

    const b = tickets.issue('s1', 0);
    expect(tickets.take(b, 's2', 1)).toBe(false); // another session…
    expect(tickets.take(b, 's1', 2)).toBe(false); // …uses it up

    const c = tickets.issue('s1', 0);
    expect(tickets.take(c, 's1', 30_000)).toBe(false); // expired
    expect(tickets.take('made-up', 's1')).toBe(false);
  });

  it('long and random', () => {
    const tickets = new TerminalTickets();
    const a = tickets.issue('s1');
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(tickets.issue('s1')).not.toBe(a);
  });
});
