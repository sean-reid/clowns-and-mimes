import type { Topology } from '@cm/shared';

export const VALID_TOPOLOGIES: readonly Topology[] = [
  'plane',
  'torus',
  'klein',
  'sphere',
  'genus2',
];

export const OPEN_ROOM_SOFT_CAPACITY = 12;
export const OPEN_ROOM_FRESH_MS = 5 * 60 * 1000;
export const OPEN_ROOM_PRUNE_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'openRooms';

export interface OpenRoomEntry {
  roomId: string;
  topology: Topology;
  humans: number;
  bots: number;
  lastSeenAt: number;
  createdAt: number;
}

interface OpenJoinResult {
  roomId: string;
  topology: Topology;
  created: boolean;
}

/**
 * Pure routing helper. Selects an existing open room from candidates or
 * indicates a fresh one should be created. Pulled out of the DO so it can be
 * unit-tested without spinning up a DurableObjectState stub.
 *
 * Rule: among rooms with humans+bots < OPEN_ROOM_SOFT_CAPACITY and
 * lastSeenAt within OPEN_ROOM_FRESH_MS, pick the highest humans count, then
 * highest total occupants as tiebreaker.
 */
export function pickRoom(
  openRooms: ReadonlyMap<string, OpenRoomEntry>,
  now: number,
): OpenRoomEntry | null {
  let best: OpenRoomEntry | null = null;
  for (const entry of openRooms.values()) {
    if (entry.humans + entry.bots >= OPEN_ROOM_SOFT_CAPACITY) continue;
    if (entry.lastSeenAt <= now - OPEN_ROOM_FRESH_MS) continue;
    if (best === null) {
      best = entry;
      continue;
    }
    if (entry.humans > best.humans) {
      best = entry;
      continue;
    }
    if (entry.humans === best.humans && entry.humans + entry.bots > best.humans + best.bots) {
      best = entry;
    }
  }
  return best;
}

/** Drop entries older than OPEN_ROOM_PRUNE_MS from lastSeenAt. */
export function pruneStale(openRooms: Map<string, OpenRoomEntry>, now: number): void {
  const cutoff = now - OPEN_ROOM_PRUNE_MS;
  for (const [id, entry] of openRooms) {
    if (entry.lastSeenAt <= cutoff) openRooms.delete(id);
  }
}

export function randomTopology(): Topology {
  return VALID_TOPOLOGIES[Math.floor(Math.random() * VALID_TOPOLOGIES.length)]!;
}

/**
 * Durable Object hosting the single source of truth for open-lobby room
 * counts. KV used to fill this role but is eventually consistent across
 * edges, so two near-simultaneous joins could each create a new room. A
 * single DO instance serializes routing decisions globally.
 */
export class MatchmakerDO {
  private openRooms = new Map<string, OpenRoomEntry>();
  private loaded = false;

  constructor(private readonly state: DurableObjectState) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.state.storage.get<Record<string, OpenRoomEntry>>(STORAGE_KEY);
    if (stored) {
      for (const [id, entry] of Object.entries(stored)) {
        this.openRooms.set(id, entry);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const obj: Record<string, OpenRoomEntry> = {};
    for (const [id, entry] of this.openRooms) obj[id] = entry;
    await this.state.storage.put(STORAGE_KEY, obj);
  }

  async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);
    pruneStale(this.openRooms, Date.now());

    if (req.method === 'POST' && url.pathname === '/openJoin') {
      return this.openJoin();
    }
    if (req.method === 'POST' && url.pathname === '/roomState') {
      return this.roomState(req);
    }
    if (req.method === 'POST' && url.pathname === '/roomDetach') {
      return this.roomDetach(req);
    }
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  private async openJoin(): Promise<Response> {
    const now = Date.now();
    const reusable = pickRoom(this.openRooms, now);
    let result: OpenJoinResult;
    if (reusable) {
      reusable.humans += 1;
      reusable.lastSeenAt = now;
      this.openRooms.set(reusable.roomId, reusable);
      result = { roomId: reusable.roomId, topology: reusable.topology, created: false };
    } else {
      const roomId = crypto.randomUUID();
      const topology = randomTopology();
      const entry: OpenRoomEntry = {
        roomId,
        topology,
        humans: 1,
        bots: 0,
        lastSeenAt: now,
        createdAt: now,
      };
      this.openRooms.set(roomId, entry);
      result = { roomId, topology, created: true };
    }
    await this.persist();
    return json(result);
  }

  private async roomState(req: Request): Promise<Response> {
    let body: { roomId?: unknown; humans?: unknown; bots?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (
      typeof body.roomId !== 'string' ||
      typeof body.humans !== 'number' ||
      typeof body.bots !== 'number'
    ) {
      return json({ error: 'invalid_body' }, 400);
    }
    const now = Date.now();
    const existing = this.openRooms.get(body.roomId);
    if (existing) {
      existing.humans = Math.max(0, Math.floor(body.humans));
      existing.bots = Math.max(0, Math.floor(body.bots));
      existing.lastSeenAt = now;
      this.openRooms.set(body.roomId, existing);
    } else {
      // Room signaled state but the DO never minted it - record it anyway so
      // future routing can find it. Topology is unknown; default to a random
      // one. This path is unusual (a room created outside /openJoin) but
      // staying defensive avoids losing the entry.
      this.openRooms.set(body.roomId, {
        roomId: body.roomId,
        topology: randomTopology(),
        humans: Math.max(0, Math.floor(body.humans)),
        bots: Math.max(0, Math.floor(body.bots)),
        lastSeenAt: now,
        createdAt: now,
      });
    }
    await this.persist();
    return json({ ok: true });
  }

  private async roomDetach(req: Request): Promise<Response> {
    let body: { roomId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (typeof body.roomId !== 'string') return json({ error: 'invalid_body' }, 400);
    const entry = this.openRooms.get(body.roomId);
    if (entry) {
      if (entry.humans + entry.bots === 0) {
        this.openRooms.delete(body.roomId);
      } else {
        entry.lastSeenAt = Date.now();
        this.openRooms.set(body.roomId, entry);
      }
    }
    await this.persist();
    return json({ ok: true });
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
