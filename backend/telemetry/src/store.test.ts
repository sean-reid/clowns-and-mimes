import { describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '@cm/shared';
import { dayKey, eventKey, makeKvStore } from './store.ts';

interface MockKV {
  store: Map<string, string>;
  ttl: Map<string, number>;
}

function makeMockKv(): { kv: KVNamespace; mock: MockKV } {
  const mock: MockKV = { store: new Map(), ttl: new Map() };
  const kv = {
    async get<T>(key: string, type?: 'json'): Promise<T | string | null> {
      const v = mock.store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? (JSON.parse(v) as T) : v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      mock.store.set(key, value);
      if (opts?.expirationTtl) mock.ttl.set(key, opts.expirationTtl);
    },
  } as unknown as KVNamespace;
  return { kv, mock };
}

describe('dayKey', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    expect(dayKey(new Date('2026-05-30T01:23:45Z'))).toBe('2026-05-30');
  });
  it('rolls over at UTC midnight regardless of local time', () => {
    expect(dayKey(new Date('2026-05-31T00:00:01Z'))).toBe('2026-05-31');
  });
});

describe('eventKey', () => {
  it('namespaces by day and type', () => {
    expect(eventKey('2026-05-30', 'session_start')).toBe('tel:2026-05-30:session_start');
  });
});

describe('makeKvStore.append', () => {
  it('writes nothing on empty input', async () => {
    const { kv, mock } = makeMockKv();
    const store = makeKvStore(kv, 30);
    const n = await store.append([], new Date('2026-05-30T12:00:00Z'));
    expect(n).toBe(0);
    expect(mock.store.size).toBe(0);
  });

  it('groups events by type and appends to existing day key', async () => {
    const { kv, mock } = makeMockKv();
    const store = makeKvStore(kv, 30);
    const now = new Date('2026-05-30T12:00:00Z');
    const evs: TelemetryEvent[] = [
      { t: 'session_start', v: '0.6.0', platform: 'mac', telemetryId: 'abc' },
      { t: 'item_pickup', itemType: 'leap' },
      { t: 'item_pickup', itemType: 'portal' },
    ];
    await store.append(evs, now);
    const sessionKey = eventKey('2026-05-30', 'session_start');
    const pickupKey = eventKey('2026-05-30', 'item_pickup');
    expect(JSON.parse(mock.store.get(sessionKey)!)).toHaveLength(1);
    expect(JSON.parse(mock.store.get(pickupKey)!)).toHaveLength(2);
  });

  it('appends to the same key on a second call', async () => {
    const { kv, mock } = makeMockKv();
    const store = makeKvStore(kv, 30);
    const now = new Date('2026-05-30T12:00:00Z');
    await store.append([{ t: 'item_pickup', itemType: 'leap' }], now);
    await store.append([{ t: 'item_pickup', itemType: 'radar' }], now);
    const key = eventKey('2026-05-30', 'item_pickup');
    expect(JSON.parse(mock.store.get(key)!)).toHaveLength(2);
  });

  it('sets the retention TTL on each write', async () => {
    const { kv, mock } = makeMockKv();
    const store = makeKvStore(kv, 7);
    await store.append(
      [{ t: 'session_start', v: '0.6.0', platform: 'linux', telemetryId: 'x' }],
      new Date('2026-05-30T00:00:00Z'),
    );
    const key = eventKey('2026-05-30', 'session_start');
    expect(mock.ttl.get(key)).toBe(7 * 24 * 60 * 60);
  });
});
