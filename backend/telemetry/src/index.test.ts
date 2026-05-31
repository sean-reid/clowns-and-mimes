import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index.ts';

interface MockKV {
  store: Map<string, string>;
}

function makeEnv(): { env: Env; mock: MockKV } {
  const mock: MockKV = { store: new Map() };
  const kv = {
    async get<T>(key: string, type?: 'json'): Promise<T | string | null> {
      const v = mock.store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? (JSON.parse(v) as T) : v;
    },
    async put(key: string, value: string): Promise<void> {
      mock.store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { env: { EVENTS: kv, ENV: 'test', RETENTION_DAYS: '30' }, mock };
}

async function call(env: Env, init: { method: string; path: string; body?: unknown }) {
  const req = new Request(`https://test.workers.dev${init.path}`, {
    method: init.method,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
  });
  return worker.fetch(req, env);
}

describe('telemetry worker', () => {
  it('healthz returns ok with the env stamp', async () => {
    const { env } = makeEnv();
    const res = await call(env, { method: 'GET', path: '/healthz' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: 'test' });
  });

  it('rejects POST /events with invalid JSON', async () => {
    const { env } = makeEnv();
    const req = new Request('https://t.workers.dev/events', {
      method: 'POST',
      body: 'not-json{',
      headers: { 'content-type': 'application/json' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('rejects POST /events without an events array', async () => {
    const { env } = makeEnv();
    const res = await call(env, {
      method: 'POST',
      path: '/events',
      body: { telemetryId: 'x' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects POST /events with too many events', async () => {
    const { env } = makeEnv();
    const events = Array.from({ length: 51 }, () => ({
      t: 'item_pickup',
      itemType: 'leap',
    }));
    const res = await call(env, {
      method: 'POST',
      path: '/events',
      body: { events, telemetryId: 'x', clientVersion: '0.6.0' },
    });
    expect(res.status).toBe(413);
  });

  it('writes a valid envelope and reports the count', async () => {
    const { env, mock } = makeEnv();
    const res = await call(env, {
      method: 'POST',
      path: '/events',
      body: {
        events: [
          { t: 'session_start', v: '0.6.0', platform: 'mac', telemetryId: 'abc' },
          { t: 'match_end', durationS: 120, outcome: 'won', team: 'mime' },
        ],
        telemetryId: 'abc',
        clientVersion: '0.6.0',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, written: 2 });
    expect(mock.store.size).toBe(2);
  });

  it('silently drops unknown event types in an otherwise valid envelope', async () => {
    const { env, mock } = makeEnv();
    const res = await call(env, {
      method: 'POST',
      path: '/events',
      body: {
        events: [
          { t: 'session_start', v: '0.6.0', platform: 'mac', telemetryId: 'abc' },
          { t: 'mystery_event', foo: 'bar' },
        ],
        telemetryId: 'abc',
        clientVersion: '0.6.0',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: 1 });
    expect(mock.store.size).toBe(1);
  });

  it('returns 404 on unrecognized paths', async () => {
    const { env } = makeEnv();
    const res = await call(env, { method: 'GET', path: '/whatever' });
    expect(res.status).toBe(404);
  });
});
