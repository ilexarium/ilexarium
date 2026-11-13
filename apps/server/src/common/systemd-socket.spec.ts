import type { AddressInfo } from 'node:net';
import { passedSockets, socketMismatch } from './systemd-socket.js';

const at = (address: string, port = 3000): AddressInfo => ({
  address,
  port,
  family: address.includes(':') ? 'IPv6' : 'IPv4',
});

describe('passedSockets', () => {
  it('none without systemd’s variables: the app listens on HOST and PORT itself', () => {
    expect(passedSockets({}, 4242)).toEqual([]);
    expect(passedSockets({ LISTEN_FDS: '1' }, 4242)).toEqual([]);
  });

  it('none when the variables name another process (inherited, not passed to this one)', () => {
    expect(passedSockets({ LISTEN_PID: '4243', LISTEN_FDS: '1' }, 4242)).toEqual([]);
    expect(passedSockets({ LISTEN_PID: '04242', LISTEN_FDS: '1' }, 4242)).toEqual([]);
  });

  it('the descriptors from 3 when they name this process', () => {
    expect(passedSockets({ LISTEN_PID: '4242', LISTEN_FDS: '1' }, 4242)).toEqual([3]);
    expect(passedSockets({ LISTEN_PID: '4242', LISTEN_FDS: '2' }, 4242)).toEqual([3, 4]);
  });

  it('refuses a count ilex.socket never passes', () => {
    for (const count of [undefined, '', '0', '3', '-1', '1x', ' 1', '1.0']) {
      expect(
        () => passedSockets({ LISTEN_PID: '4242', LISTEN_FDS: count }, 4242),
        String(count),
      ).toThrow(/LISTEN_FDS/);
    }
  });
});

describe('socketMismatch', () => {
  it('127.0.0.1 (and the production default): 127.0.0.1 with ::1 beside it, or alone', () => {
    for (const host of ['127.0.0.1', undefined]) {
      expect(socketMismatch([at('127.0.0.1'), at('::1')], host, 3000)).toBeNull();
      expect(socketMismatch([at('127.0.0.1')], host, 3000)).toBeNull();
    }
  });

  it('::1 with 127.0.0.1 beside it; 0.0.0.0 with ::1', () => {
    expect(socketMismatch([at('::1'), at('127.0.0.1')], '::1', 3000)).toBeNull();
    expect(socketMismatch([at('0.0.0.0'), at('::1')], '0.0.0.0', 3000)).toBeNull();
  });

  it('every address of both kinds, or another address: that one alone', () => {
    expect(socketMismatch([at('::')], '::', 3000)).toBeNull();
    expect(socketMismatch([at('192.168.1.10')], '192.168.1.10', 3000)).toBeNull();
    expect(socketMismatch([at('fd00::5')], 'fd00:0:0::5', 3000)).toBeNull();
  });

  it('another port: says how to move the socket', () => {
    expect(socketMismatch([at('127.0.0.1'), at('::1')], '127.0.0.1', 3300)).toBe(
      'ilex.socket listens on 127.0.0.1:3000, [::1]:3000 — not on 127.0.0.1:3300 as HOST and ' +
        'PORT say. After a change to HOST or PORT in /etc/ilex/app.env: systemctl ' +
        'daemon-reload && systemctl restart ilex.socket',
    );
  });

  it('HOST’s own address missing, or one it doesn’t name', () => {
    expect(socketMismatch([at('::1')], '127.0.0.1', 3000)).toMatch(/^ilex.socket listens on/);
    expect(socketMismatch([at('::1')], '0.0.0.0', 3000)).toMatch(/not on 0.0.0.0:3000/);
    expect(socketMismatch([at('127.0.0.1'), at('0.0.0.0')], '127.0.0.1', 3000)).not.toBeNull();
    expect(socketMismatch([at('127.0.0.1')], '192.168.1.10', 3000)).not.toBeNull();
    expect(socketMismatch([at('0.0.0.0')], '::', 3000)).not.toBeNull();
    expect(socketMismatch([], '127.0.0.1', 3000)).toMatch(/listens on nothing/);
  });
});
