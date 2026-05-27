/**
 * Wire protocol shared between the game client and the room Durable Object.
 * Bump PROTOCOL_VERSION on every breaking change. The room rejects mismatches.
 */

export const PROTOCOL_VERSION = 2 as const;

export type Team = 'mime' | 'clown';

// XZ planar vector. Inputs and topology helpers stay 2D because all
// horizontal motion is planar; Y is handled separately by physics.ts.
export interface Vec2 {
  x: number;
  z: number;
}

// Full 3D position used for player state on the wire. Y is the vertical
// axis; players hover at HOVER_HEIGHT and rise during a jump per the
// arc in physics.ts.
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerInput {
  seq: number;
  dt: number;
  move: Vec2;
  lookYaw: number;
  sprint: boolean;
  actionTag?: string;
  actionUnfreeze?: string;
}

export interface PlayerState {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
  position: Vec3;
  yaw: number;
  frozen: boolean;
  sprintEnergy: number;
  // Sprint hysteresis: once energy depletes to 0 mid-sprint the player
  // drops to walk and stays there until energy regens past
  // SPRINT_ENGAGE_THRESHOLD. Without this latch a sprint-held key would
  // flip-flop between WALK_SPEED and SPRINT_SPEED tick-to-tick at the
  // 0-energy line, producing visible 20 Hz jitter.
  sprinting: boolean;
  // Millisecond timestamp of the current jump's takeoff, or null if the
  // player is not currently jumping. The server clears this back to null
  // once the arc window expires. Y is a deterministic function of this
  // field (see physics.ts::jumpArcY), so the wire carries the timestamp
  // rather than the height itself; client and server both compute Y from
  // the same source.
  jumpStartedAt: number | null;
}

export type RoomPhase = 'filling' | 'locked' | 'free_roam' | 'turn_mime' | 'turn_clown' | 'ended';

export interface RoomSnapshot {
  v: typeof PROTOCOL_VERSION;
  roomId: string;
  seed: number;
  topology: Topology;
  phase: RoomPhase;
  turnEndsAt: number;
  players: PlayerState[];
  winner?: Team;
}

export type Topology = 'plane' | 'torus' | 'mobius' | 'klein';

export type ClientToServer =
  // hostToken is the random secret the matchmaker hands the host on lobby
  // create. The server uses it to identify which connected player is the
  // host so the start_match message below can be gated to that one player.
  // sessionToken is the per-player secret the server hands back in the
  // snapshot. The client stashes it and sends it on subsequent joins so
  // that a transient WS drop is resumed against the same PlayerState
  // (including team, position, frozen status) instead of being treated
  // as a fresh join (which would be rejected mid-match or, worse, race
  // ahead of a stale match-state teardown).
  | {
      t: 'join';
      v: number;
      name: string;
      preferTeam?: Team;
      hostToken?: string;
      sessionToken?: string;
    }
  | { t: 'leave' }
  | { t: 'input'; input: PlayerInput }
  | { t: 'tag_attempt'; targetId: string; clientTime: number }
  | { t: 'unfreeze_attempt'; targetId: string; clientTime: number }
  | { t: 'ping'; clientTime: number }
  // Private-lobby host transitions the room out of `filling` and into
  // `free_roam`. Server fills empty slots with bots on receipt and rejects
  // the message from any non-host player or when the phase is past
  // `filling`.
  | { t: 'start_match' };

export type ServerToClient =
  // sessionToken is the resumption secret for the recipient of this
  // snapshot only. Other clients never see this client's token. Stash
  // and send it on the next join after a WS drop to resume the same
  // PlayerState rather than spawning fresh.
  | { t: 'snapshot'; snapshot: RoomSnapshot; youAre: string; sessionToken: string }
  | { t: 'delta'; players: PlayerState[]; phase: RoomPhase; turnEndsAt: number; ackSeq: number }
  | { t: 'event'; kind: GameEvent }
  | { t: 'tag_result'; ok: boolean; targetId?: string; reason?: string }
  | { t: 'unfreeze_result'; ok: boolean; targetId?: string; reason?: string }
  | { t: 'pong'; serverTime: number; clientTime: number }
  | { t: 'error'; code: ErrorCode; message: string };

export type GameEvent =
  | { kind: 'tagged'; victimId: string; attackerId: string; team: Team }
  | { kind: 'saved'; victimId: string; saviorId: string }
  // cryIndex is the server-picked battle-cry slot for turn_mime / turn_clown
  // phases. All clients render the same cry by indexing into their local
  // MIME_BATTLE_CRIES / CLOWN_BATTLE_CRIES list. Omitted on non-turn phases.
  | { kind: 'phase'; phase: RoomPhase; cryIndex?: number }
  | { kind: 'win'; team: Team };

export const BATTLE_CRY_COUNT = 8;

export type ErrorCode =
  | 'version_mismatch'
  | 'room_full'
  | 'room_not_found'
  | 'invalid_message'
  | 'rate_limited'
  | 'internal'
  | 'match_in_progress'
  | 'not_host';

export interface MatchmakeCreateBody {
  topology: Topology;
  hostName?: string;
}

export interface MatchmakeCreateResponse {
  code: string;
  roomId: string;
  wsUrl: string;
  // Random secret minted at lobby creation. The client passes it as the
  // hostToken on its WS `join` message; the server uses it to identify the
  // host so the `start_match` message is gated to that one player.
  // Joiners (POST /lobby/:code/join) do NOT receive this, only the host.
  hostToken: string;
}

export interface MatchmakeJoinResponse {
  roomId: string;
  wsUrl: string;
}
