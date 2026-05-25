import { describe, expect, it, beforeEach } from 'vitest';
import worker, { type Env } from './index.ts';
import { MatchmakerDO } from './matchmakerDO.ts';

class FakeKV {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttl = options?.expirationTtl ?? 60;
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: true;
    cacheStatus: null;
  }> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .slice(0, options?.limit ?? 1000)
      .map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

class FakeStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}

/**
 * Routes worker fetches to a single in-memory MatchmakerDO instance keyed by
 * the DO name. This sidesteps `unstable_dev` while still exercising the same
 * code path the production worker uses.
 */
class FakeDONamespace {
  private readonly instances = new Map<string, MatchmakerDO>();

  idFromName(name: string): DurableObjectId {
    return { toString: () => name, name } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): {
    fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
  } {
    const key = id.toString();
    let instance = this.instances.get(key);
    if (!instance) {
      const state = { storage: new FakeStorage() } as unknown as DurableObjectState;
      instance = new MatchmakerDO(state);
      this.instances.set(key, instance);
    }
    const target = instance;
    return {
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        return target.fetch(req);
      },
    };
  }
}

function makeEnv(): Env {
  return {
    LOBBY_CODES: new FakeKV() as unknown as KVNamespace,
    MATCHMAKER_DO: new FakeDONamespace() as unknown as DurableObjectNamespace,
    ROOM_WORKER: 'test-room',
    WORKERS_SUBDOMAIN: 'test-account',
    ENV: 'test',
  };
}

async function call(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://x.test${path}`, {
      method,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    }),
    env,
  );
}

describe('matchmaker', () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
  });

  it('creates a private lobby with a code and returns ws url', async () => {
    const res = await call(env, 'POST', '/lobby', { topology: 'torus' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; roomId: string; wsUrl: string };
    expect(body.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXYZ23456789]{6}$/);
    expect(body.wsUrl).toContain('test-room');
  });

  it('rejects invalid topology', async () => {
    const res = await call(env, 'POST', '/lobby', { topology: 'hyperboloid' });
    expect(res.status).toBe(400);
  });

  it('joins by code', async () => {
    const created = await call(env, 'POST', '/lobby', { topology: 'plane' });
    const { code, roomId } = (await created.json()) as { code: string; roomId: string };
    const res = await call(env, 'POST', `/lobby/${code}/join`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roomId: string };
    expect(body.roomId).toBe(roomId);
  });

  it('returns 404 for unknown code', async () => {
    const res = await call(env, 'POST', '/lobby/UNKNOWN/join');
    expect(res.status).toBe(404);
  });

  it('reuses an existing open room when capacity remains', async () => {
    const first = await call(env, 'POST', '/open/join');
    const second = await call(env, 'POST', '/open/join');
    const a = (await first.json()) as { roomId: string };
    const b = (await second.json()) as { roomId: string };
    expect(b.roomId).toBe(a.roomId);
  });

  it('open join returns a topology field sourced from the DO', async () => {
    const res = await call(env, 'POST', '/open/join');
    const body = (await res.json()) as { topology: string };
    expect(['plane', 'torus', 'mobius', 'klein']).toContain(body.topology);
  });

  it('room-state forwards to the DO and is reflected in routing', async () => {
    const first = await call(env, 'POST', '/open/join');
    const { roomId } = (await first.json()) as { roomId: string };
    // Saturate the room past soft capacity so the next openJoin mints a new one.
    const res = await call(env, 'POST', '/lobby/room-state', { roomId, humans: 12, bots: 0 });
    expect(res.status).toBe(200);
    const second = await call(env, 'POST', '/open/join');
    const body = (await second.json()) as { roomId: string };
    expect(body.roomId).not.toBe(roomId);
  });

  it('room-detach forwards to the DO', async () => {
    const first = await call(env, 'POST', '/open/join');
    const { roomId } = (await first.json()) as { roomId: string };
    await call(env, 'POST', '/lobby/room-state', { roomId, humans: 0, bots: 0 });
    const detach = await call(env, 'POST', '/lobby/room-detach', { roomId });
    expect(detach.status).toBe(200);
    const second = await call(env, 'POST', '/open/join');
    const body = (await second.json()) as { roomId: string };
    expect(body.roomId).not.toBe(roomId);
  });

  it('healthz returns ok', async () => {
    const res = await call(env, 'GET', '/healthz');
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
