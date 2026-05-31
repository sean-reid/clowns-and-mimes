// Persists Room state to Durable Object storage so the in-memory state
// survives DO restarts (wrangler deploys, CF migrations, crashes).
//
// Before this module landed, every wrangler deploy bounced every running
// room: SessionManager.sessionTokens and Room.players (both in-memory
// Maps) reset to empty. Clients reconnected within < 1 s thanks to the
// reconnect ladder, presented their sessionToken, the fresh DO had no
// matching entry, and they got dumped into a fresh-join codepath - new
// match, new seed, walk-through-walls because the client kept its old
// labyrinth. See the 2026-05-28 playtest report.
//
// Single storage key `room:state:v2`. The whole room snapshot is one
// blob because the players are read together with the phase/seed/host
// fields on restart - separating them would let restore see an
// inconsistent intermediate state if a write was interrupted. CF DO
// storage coalesces multiple `put`s within an I/O turn into one disk
// write, so save() is fire-and-forget and call sites stay synchronous.

import type { PlayerState, RoomPhase, Team, Topology } from '@cm/shared';
import type { ItemState } from './itemManager.ts';

export interface PersistedRoomState {
  // Bumped when the schema changes incompatibly. load() returns null if
  // the on-disk version doesn't match, so a deploy that introduces a new
  // shape starts the rooms fresh rather than crashing on restore.
  version: 2;
  phase: RoomPhase;
  turnEndsAt: number;
  topology: Topology;
  seed: number;
  roundNumber: number;
  firstTeam: Team;
  expectedHostToken: string | null;
  hostPlayerId: string | null;
  // Every player in the room at write time, humans + bots. Bots are
  // included so restart does not double-fill them (the room re-fills if
  // these are dropped, producing 2x the intended bot count).
  players: PlayerState[];
  // Live item state including in-flight respawn timers, so a deploy
  // mid-match restores pickups already taken rather than re-spawning them.
  items: ItemState[];
  // [playerId, sessionToken]. Restored straight back into SessionManager
  // so the client's existing token still resolves on resume.
  sessions: Array<[string, string]>;
  // [playerId, graceExpiresAtMs]. The wall-clock at which the 45 s grace
  // for each in-flight disconnect was scheduled to fire. On restore the
  // grace timer is re-armed with the remaining time (or fires immediately
  // if already past).
  pendingDisconnects: Array<[string, number]>;
}

const STORAGE_KEY = 'room:state:v2';

export class RoomPersistence {
  constructor(private readonly storage: DurableObjectStorage) {}

  /**
   * Load the persisted room state if any. Returns null on first boot
   * (key absent) or after a schema version bump.
   */
  async load(): Promise<PersistedRoomState | null> {
    const v = await this.storage.get<PersistedRoomState>(STORAGE_KEY);
    if (!v) return null;
    if (v.version !== 2) return null;
    return v;
  }

  /**
   * Fire-and-forget save. CF DO storage coalesces multiple put()s in the
   * same I/O turn into one disk write, so a tick that mutates several
   * fields and calls save() at each step still costs exactly one write.
   * Errors are swallowed because the next save() will overwrite the same
   * key anyway; persistence is best-effort by design.
   */
  save(state: PersistedRoomState): void {
    void this.storage.put(STORAGE_KEY, state).catch(() => {
      // Best-effort. Next save will retry with newer state.
    });
  }

  /**
   * Drop the persisted blob. Called when the room is fully torn down
   * (last human leaves, finalizeDisconnect clears state) so the next
   * client to land here gets a clean room instead of a stale snapshot
   * from yesterday.
   */
  clear(): void {
    void this.storage.delete(STORAGE_KEY).catch(() => {
      // Best-effort.
    });
  }
}
