import type { PartyMember, PartyView, Team, Topology } from '@cm/shared';
import { PARTY_CAP } from '@cm/shared';

export const VALID_TOPOLOGIES: readonly Topology[] = ['plane', 'torus', 'mobius', 'klein'];

export const OPEN_ROOM_SOFT_CAPACITY = 12;
export const OPEN_ROOM_FRESH_MS = 5 * 60 * 1000;
export const OPEN_ROOM_PRUNE_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'openRooms';

// Parties are dropped after this long without a create/join/leave/open-join
// touch, so a party someone formed and abandoned can't pin storage forever.
export const PARTY_PRUNE_MS = 30 * 60 * 1000;
const PARTY_STORAGE_KEY = 'parties';
const PARTY_CODE_LENGTH = 6;
const PARTY_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';

export interface OpenRoomEntry {
  roomId: string;
  topology: Topology;
  humans: number;
  bots: number;
  lastSeenAt: number;
  createdAt: number;
}

export interface PartyEntry {
  id: string;
  code: string;
  // Team every member requests as their join preferTeam. Fixed at create so
  // the whole party groups even if they open-join several seconds apart.
  team: Team;
  members: PartyMember[];
  // Room the first member's open-join landed in; later members route here so
  // they share a room. Null until the first member finds a match.
  roomId: string | null;
  createdAt: number;
  lastSeenAt: number;
}

interface OpenJoinResult {
  roomId: string;
  topology: Topology;
  created: boolean;
  team?: Team;
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

export function randomTeam(): Team {
  return Math.random() < 0.5 ? 'mime' : 'clown';
}

/** Drop parties untouched for longer than PARTY_PRUNE_MS. */
export function pruneStaleParties(parties: Map<string, PartyEntry>, now: number): void {
  const cutoff = now - PARTY_PRUNE_MS;
  for (const [id, party] of parties) {
    if (party.lastSeenAt <= cutoff) parties.delete(id);
  }
}

function randomPartyCode(): string {
  const buf = new Uint8Array(PARTY_CODE_LENGTH);
  crypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) out += PARTY_CODE_ALPHABET[byte % PARTY_CODE_ALPHABET.length];
  return out;
}

/**
 * Durable Object hosting the single source of truth for open-lobby room
 * counts. KV used to fill this role but is eventually consistent across
 * edges, so two near-simultaneous joins could each create a new room. A
 * single DO instance serializes routing decisions globally.
 */
export class MatchmakerDO {
  private openRooms = new Map<string, OpenRoomEntry>();
  private parties = new Map<string, PartyEntry>();
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
    const storedParties =
      await this.state.storage.get<Record<string, PartyEntry>>(PARTY_STORAGE_KEY);
    if (storedParties) {
      for (const [id, party] of Object.entries(storedParties)) {
        this.parties.set(id, party);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const obj: Record<string, OpenRoomEntry> = {};
    for (const [id, entry] of this.openRooms) obj[id] = entry;
    await this.state.storage.put(STORAGE_KEY, obj);
  }

  private async persistParties(): Promise<void> {
    const obj: Record<string, PartyEntry> = {};
    for (const [id, party] of this.parties) obj[id] = party;
    await this.state.storage.put(PARTY_STORAGE_KEY, obj);
  }

  async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);
    const now = Date.now();
    pruneStale(this.openRooms, now);
    pruneStaleParties(this.parties, now);

    if (req.method === 'POST' && url.pathname === '/openJoin') {
      return this.openJoin(req);
    }
    if (req.method === 'POST' && url.pathname === '/roomState') {
      return this.roomState(req);
    }
    if (req.method === 'POST' && url.pathname === '/roomDetach') {
      return this.roomDetach(req);
    }
    if (req.method === 'POST' && url.pathname === '/partyCreate') {
      return this.partyCreate(req);
    }
    if (req.method === 'POST' && url.pathname === '/partyJoin') {
      return this.partyJoin(req);
    }
    if (req.method === 'POST' && url.pathname === '/partyLeave') {
      return this.partyLeave(req);
    }
    if (req.method === 'GET' && url.pathname === '/partyState') {
      return this.partyStateView(url.searchParams.get('id'));
    }
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  private async openJoin(req: Request): Promise<Response> {
    const now = Date.now();
    let partyId: string | undefined;
    try {
      const body = (await req.json()) as { partyId?: unknown };
      if (typeof body.partyId === 'string') partyId = body.partyId;
    } catch {
      // Body is optional; a non-party open-join sends '{}' or nothing.
    }

    const party = partyId ? this.parties.get(partyId) : undefined;
    // A later party member reuses the room the first member already landed in,
    // as long as it's still around, fresh, and under capacity. Otherwise (first
    // member, or the shared room aged out / filled / detached) we route fresh
    // and re-stamp the party so the rest follow.
    if (party && party.roomId) {
      const shared = this.openRooms.get(party.roomId);
      if (shared && shared.humans + shared.bots < OPEN_ROOM_SOFT_CAPACITY) {
        shared.humans += 1;
        shared.lastSeenAt = now;
        this.openRooms.set(shared.roomId, shared);
        party.lastSeenAt = now;
        await this.persist();
        await this.persistParties();
        return json({
          roomId: shared.roomId,
          topology: shared.topology,
          created: false,
          team: party.team,
        } satisfies OpenJoinResult);
      }
    }

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
    if (party) {
      party.roomId = result.roomId;
      party.lastSeenAt = now;
      result.team = party.team;
      await this.persistParties();
    }
    await this.persist();
    return json(result);
  }

  private async partyCreate(req: Request): Promise<Response> {
    let body: { name?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name : '';
    const now = Date.now();
    const member: PartyMember = { memberId: crypto.randomUUID(), name };
    const party: PartyEntry = {
      id: crypto.randomUUID(),
      code: this.freshPartyCode(),
      team: randomTeam(),
      members: [member],
      roomId: null,
      createdAt: now,
      lastSeenAt: now,
    };
    this.parties.set(party.id, party);
    await this.persistParties();
    return json(this.partyResponse(party, member.memberId));
  }

  private async partyJoin(req: Request): Promise<Response> {
    let body: { code?: unknown; name?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (typeof body.code !== 'string') return json({ error: 'invalid_body' }, 400);
    const code = body.code.toUpperCase();
    const party = [...this.parties.values()].find((p) => p.code === code);
    if (!party) return json({ error: 'party_not_found' }, 404);
    if (party.members.length >= PARTY_CAP) return json({ error: 'party_full' }, 409);
    const name = typeof body.name === 'string' ? body.name : '';
    const member: PartyMember = { memberId: crypto.randomUUID(), name };
    party.members.push(member);
    party.lastSeenAt = Date.now();
    await this.persistParties();
    return json(this.partyResponse(party, member.memberId));
  }

  private async partyLeave(req: Request): Promise<Response> {
    let body: { partyId?: unknown; memberId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (typeof body.partyId !== 'string' || typeof body.memberId !== 'string') {
      return json({ error: 'invalid_body' }, 400);
    }
    const party = this.parties.get(body.partyId);
    if (party) {
      party.members = party.members.filter((m) => m.memberId !== body.memberId);
      if (party.members.length === 0) {
        this.parties.delete(party.id);
      } else {
        party.lastSeenAt = Date.now();
      }
      await this.persistParties();
    }
    return json({ ok: true });
  }

  // Read-only roster fetch backing the party screen's poll. Bumps lastSeenAt
  // so a party someone is actively watching doesn't age into the prune window;
  // the bump stays in memory (no persist) to keep the 2s poll off storage.
  private partyStateView(id: string | null): Response {
    const party = id ? this.parties.get(id) : undefined;
    if (!party) return json({ error: 'party_not_found' }, 404);
    party.lastSeenAt = Date.now();
    return json({
      partyId: party.id,
      code: party.code,
      team: party.team,
      members: party.members,
      roomId: party.roomId,
    } satisfies PartyView);
  }

  private partyResponse(party: PartyEntry, memberId: string) {
    return {
      partyId: party.id,
      code: party.code,
      team: party.team,
      memberId,
      members: party.members,
    };
  }

  private freshPartyCode(): string {
    const taken = new Set([...this.parties.values()].map((p) => p.code));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomPartyCode();
      if (!taken.has(code)) return code;
    }
    // Astronomically unlikely with a 28^6 space and few live parties; fall back
    // to a guaranteed-unique id slice rather than throwing.
    return crypto.randomUUID().replace(/-/g, '').slice(0, PARTY_CODE_LENGTH).toUpperCase();
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
    // Update-only: the previous "defensive create" branch was resurrecting
    // entries that /roomDetach had just deleted, because the room fires
    // both /roomState and /roomDetach as fire-and-forget POSTs in the
    // same tick at match start (fillTeams notify -> startMatch detach)
    // and the matchmaker doesn't guarantee receive order. End state with
    // the create branch was: A deleted by detach, then A recreated with
    // a random topology by the late-arriving roomState. Subsequent
    // /openJoin handed A back to the next player who got close-4003
    // because the room's phase was free_roam. It also incidentally
    // added private lobbies (joined via /lobby/:code/join) to the open
    // pool, since they call notifyMatchmaker from onJoin too. Entries
    // are created exclusively via /openJoin now.
    if (existing) {
      existing.humans = Math.max(0, Math.floor(body.humans));
      existing.bots = Math.max(0, Math.floor(body.bots));
      existing.lastSeenAt = now;
      this.openRooms.set(body.roomId, existing);
      await this.persist();
    }
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
    // Always remove the entry. Rooms call detach precisely when they
    // are no longer eligible to receive new joiners (phase moved past
    // 'filling' in the Room's notifyMatchmaker gate). Previously this
    // path bumped lastSeenAt but kept the entry whenever humans+bots>0
    // - which is exactly the case when the room is mid-match - so the
    // next /openJoin happily handed the same room back to a new player,
    // who got a close-4003 'match_in_progress' from the room. If the
    // room later drops back to filling it can re-attach via the next
    // notifyMatchmaker -> /roomState call, which auto-creates the entry.
    this.openRooms.delete(body.roomId);
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
