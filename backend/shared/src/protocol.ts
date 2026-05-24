/**
 * Wire protocol shared between the game client and the room Durable Object.
 * Bump PROTOCOL_VERSION on every breaking change. The room rejects mismatches.
 */

export const PROTOCOL_VERSION = 1 as const;

export type Team = 'mime' | 'clown';

export interface Vec2 {
  x: number;
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
  position: Vec2;
  yaw: number;
  frozen: boolean;
  sprintEnergy: number;
  // Sprint hysteresis: once energy depletes to 0 mid-sprint the player
  // drops to walk and stays there until energy regens past
  // SPRINT_ENGAGE_THRESHOLD. Without this latch a sprint-held key would
  // flip-flop between WALK_SPEED and SPRINT_SPEED tick-to-tick at the
  // 0-energy line, producing visible 20 Hz jitter.
  sprinting: boolean;
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

export type Topology = 'plane' | 'torus' | 'klein' | 'sphere';

export type ClientToServer =
  | { t: 'join'; v: number; name: string; preferTeam?: Team }
  | { t: 'leave' }
  | { t: 'input'; input: PlayerInput }
  | { t: 'tag_attempt'; targetId: string; clientTime: number }
  | { t: 'unfreeze_attempt'; targetId: string; clientTime: number }
  | { t: 'ping'; clientTime: number };

export type ServerToClient =
  | { t: 'snapshot'; snapshot: RoomSnapshot; youAre: string }
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
  | 'internal';

export interface MatchmakeCreateBody {
  topology: Topology;
  hostName?: string;
}

export interface MatchmakeCreateResponse {
  code: string;
  roomId: string;
  wsUrl: string;
}

export interface MatchmakeJoinResponse {
  roomId: string;
  wsUrl: string;
}
