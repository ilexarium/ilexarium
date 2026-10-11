import { describe, expect, it } from 'vitest';
import {
  type Container,
  type SystemSample,
  toContainerHistoryPoint,
  toSystemHistoryPoint,
} from './monitoring.js';
import { clientMessageSchema, serverMessageSchema } from './realtime.js';

const sample: SystemSample = {
  at: 1_791_720_000_000,
  cpu: { usagePercent: 12.5, loadAverage: [0.5, 0.4, 0.3] },
  memory: {
    totalBytes: 16e9,
    usedBytes: 4e9,
    availableBytes: 12e9,
    swapTotalBytes: 2e9,
    swapUsedBytes: 0,
  },
  network: [
    { name: 'eth0', rxBytesPerSec: 1000, txBytesPerSec: 200 },
    { name: 'tailscale0', rxBytesPerSec: 50, txBytesPerSec: 30 },
  ],
};

const systemUpdate = {
  uptimeSeconds: 3600,
  sample,
  disks: [{ device: '/dev/sda1', mount: '/', fsType: 'ext4', sizeBytes: 5e11, usedBytes: 1e11 }],
};

const systemSnapshot = {
  ...systemUpdate,
  host: {
    hostname: 'homelab',
    os: 'Debian GNU/Linux 13',
    kernel: '6.12.0',
    arch: 'arm64',
    cpuModel: 'Cortex-A76',
    cpuCores: 4,
  },
  history: [toSystemHistoryPoint(sample)],
};

const container: Container = {
  id: 'f3a1c9b2d4e5',
  name: 'jellyfin',
  image: 'jellyfin/jellyfin:10.11',
  state: 'running',
  health: 'healthy',
  startedAt: '2026-10-11T12:00:00.000Z',
  ports: [{ privatePort: 8096, publicPort: 8096, ip: '0.0.0.0', protocol: 'tcp' }],
  stats: {
    at: 1_791_720_000_000,
    cpuPercent: 150,
    memoryUsedBytes: 5e8,
    memoryLimitBytes: 16e9,
    netRxBytes: 1e6,
    netTxBytes: 2e6,
    blockReadBytes: 0,
    blockWriteBytes: 4096,
  },
};

describe('clientMessageSchema', () => {
  it('accepts subscribe and unsubscribe for each topic', () => {
    for (const type of ['subscribe', 'unsubscribe']) {
      for (const topic of ['system', 'containers']) {
        expect(clientMessageSchema.safeParse({ type, topic }).success, `${type} ${topic}`).toBe(
          true,
        );
      }
    }
  });

  it('rejects unknown types and topics', () => {
    expect(clientMessageSchema.safeParse({ type: 'publish', topic: 'system' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'subscribe', topic: 'logs' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'subscribe', topic: 'System' }).success).toBe(
      false,
    );
  });

  it('rejects malformed messages', () => {
    for (const message of [null, 'subscribe', [], {}, { type: 'subscribe' }, { topic: 'system' }]) {
      expect(clientMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(false);
    }
  });

  it('rejects unknown fields', () => {
    const message = { type: 'subscribe', topic: 'system', containerId: 'abc' };
    expect(clientMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe('serverMessageSchema', () => {
  it('accepts snapshots and updates for each topic', () => {
    const messages = [
      { type: 'snapshot', topic: 'system', data: systemSnapshot },
      { type: 'update', topic: 'system', data: systemUpdate },
      {
        type: 'snapshot',
        topic: 'containers',
        data: {
          dockerAvailable: true,
          containers: [container],
          history: { [container.id]: [toContainerHistoryPoint(container.stats!)] },
        },
      },
      { type: 'update', topic: 'containers', data: { dockerAvailable: true, containers: [] } },
    ];
    for (const message of messages) {
      expect(
        serverMessageSchema.safeParse(message).success,
        `${message.type} ${message.topic}`,
      ).toBe(true);
    }
  });

  it('accepts "Docker not reachable" for containers', () => {
    for (const type of ['snapshot', 'update']) {
      const message = { type, topic: 'containers', data: { dockerAvailable: false } };
      expect(serverMessageSchema.safeParse(message).success, type).toBe(true);
    }
  });

  it('rejects data that does not match the topic', () => {
    expect(
      serverMessageSchema.safeParse({ type: 'update', topic: 'containers', data: systemUpdate })
        .success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({ type: 'snapshot', topic: 'system', data: systemUpdate })
        .success,
    ).toBe(false);
  });

  it('accepts a stopped container without stats or a start time', () => {
    const stopped = {
      ...container,
      state: 'created',
      health: 'none',
      startedAt: null,
      stats: null,
    };
    const message = {
      type: 'update',
      topic: 'containers',
      data: { dockerAvailable: true, containers: [stopped] },
    };
    expect(serverMessageSchema.safeParse(message).success).toBe(true);
  });

  it('rejects an unknown container state', () => {
    const message = {
      type: 'update',
      topic: 'containers',
      data: { dockerAvailable: true, containers: [{ ...container, state: 'zombie' }] },
    };
    expect(serverMessageSchema.safeParse(message).success).toBe(false);
  });

  it('accepts the known error codes only', () => {
    expect(
      serverMessageSchema.safeParse({ type: 'error', code: 'invalid_message', message: 'Bad' })
        .success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({ type: 'error', code: 'rate_limited', message: 'Slow down' })
        .success,
    ).toBe(true);
    expect(
      serverMessageSchema.safeParse({ type: 'error', code: 'oops', message: 'x' }).success,
    ).toBe(false);
  });
});

describe('history points', () => {
  it('sums network over all interfaces of a system sample', () => {
    expect(toSystemHistoryPoint(sample)).toEqual({
      at: sample.at,
      cpuPercent: 12.5,
      memoryUsedBytes: 4e9,
      rxBytesPerSec: 1050,
      txBytesPerSec: 230,
    });
  });

  it('is zero network for a sample without interfaces', () => {
    const point = toSystemHistoryPoint({ ...sample, network: [] });
    expect(point.rxBytesPerSec).toBe(0);
    expect(point.txBytesPerSec).toBe(0);
  });

  it('takes CPU and memory from container stats', () => {
    expect(toContainerHistoryPoint(container.stats!)).toEqual({
      at: container.stats!.at,
      cpuPercent: 150,
      memoryUsedBytes: 5e8,
    });
  });
});
