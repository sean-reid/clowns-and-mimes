/**
 * Wire protocol shared between the game client and the room Durable Object.
 * Bump PROTOCOL_VERSION on every breaking change. The room rejects mismatches.
 */

export const PROTOCOL_VERSION = 3 as const;

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
  // Rising-edge jump request. Set true on the input frame where the
  // player pressed Space; false otherwise. The server triggers a new
  // jump only when the player is not already jumping and is past the
  // post-landing cooldown (see physics.ts::JUMP_COOLDOWN_S). Holding
  // the key does NOT chain jumps; the client debounces to one true
  // per press.
  jump?: boolean;
  // Wall-clock when the client emitted this input (Unix ms). Used as
  // the jumpStartedAt timestamp on jump=true so the client predictor
  // and the server agree on the arc start without a round-trip. The
  // server clamps the value into the local Date.now() ± 500 ms window
  // before stamping it, bounding client clock skew (and any nominal
  // manipulation). Required on every input - movement is unaffected
  // by the value, only jump trigger reads it.
  nowMs: number;
  actionTag?: string;
  actionUnfreeze?: string;
}

/**
 * Active projectile broadcast in deltas. Server owns the simulation;
 * clients render the position and predict locally for snappy feedback.
 * Full 3D — projectiles follow the camera's aim direction so airborne
 * targets and over-the-wall skill shots are both possible.
 */
export interface Projectile {
  id: string;
  ownerId: string;
  team: Team;
  position: Vec3;
  velocity: Vec3;
  spawnedAt: number;
  expiresAt: number;
  // Set on an Overcharge shot: the projectile passes through walls (the
  // server skips its wall-collision check) and was fired ignoring the
  // cooldown. Absent on ordinary shots. The client renders it like any
  // other projectile - it draws server positions and never tests walls.
  piercing?: boolean;
}

// Power-up kinds. surge + radar are always in a match's rotation; the rest
// are drawn deterministically from the seed at match start (see items.ts).
// PR #5 carries the state/spawn/pickup/use plumbing only; the per-type
// effects land in later PRs.
export type ItemType = 'leap' | 'portal' | 'surge' | 'clone' | 'radar' | 'overcharge' | 'cloak';

// A power-up resting on the floor. Static between pickups, so items ride the
// snapshot and change via item_spawn / item_pickup events rather than the
// per-tick delta. id is a stable `i-${index}` from the spawn layout.
export interface Item {
  id: string;
  type: ItemType;
  position: Vec3;
}

// A live teleport pair. Both mouths are anchored on wall segments; a player
// who walks within range of either mouth emerges at the other (offset into the
// adjacent open cell). The pair closes after PORTAL_DURATION_MS. Server owns the
// geometry and emergence; the wire carries only the two wall-anchored mouth
// points so all clients render the same pair. a is the activating player's
// entry mouth (the wall they faced); b is the server-picked random exit.
export interface Portal {
  id: string;
  a: Vec3;
  b: Vec3;
  expiresAt: number;
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
  // The single power-up the player is holding, or undefined for an empty
  // slot. No stacking: picking one up while holding is blocked server-side.
  activeItem?: ItemType;
  // True while the current jump arc is a Leap (high arc that clears wall
  // height). Set when a leap-armed jump triggers, cleared when the arc
  // ends. Rides the wire so client prediction and remote rendering pick
  // the boosted amplitude (Y is recomputed from jumpStartedAt on both
  // sides, so the flag - not the height - is the source of truth).
  leaping?: boolean;
  // Server-authoritative "the next jump is a Leap" flag. Set by using a
  // leap power-up, consumed (cleared) when that jump triggers. Serialized
  // with the rest of PlayerState but unused by the client.
  leapArmed?: boolean;
  // Wall-clock (Unix ms) the player's Surge power-up stays active until.
  // Surge is "active" while surgeUntil > now; it is never cleared, just left
  // in the past, so reconciliation always adopts the server's value.
  surgeUntil?: number;
  // Wall-clock (Unix ms) the player's Radar power-up stays active until. While
  // radarUntil > now the local player's minimap reveals the enemy team. Server
  // state only; the visual consumer is the minimap HUD. Like surgeUntil it is
  // never cleared, just left in the past.
  radarUntil?: number;
  // Set by using an Overcharge power-up: the player's next shot bypasses the
  // cooldown and its projectile pierces walls. Consumed (cleared) by the
  // server when that shot fires. Rides the snapshot so the client can show
  // the armed state and reconcile its optimistic local arming.
  overchargeArmed?: boolean;
  // Set on a Clone power-up's temporary ally bot: the wall-clock (Unix ms) at
  // which it despawns. Present only on clones (undefined on real players and
  // ordinary bots), so it doubles as the "is a clone" marker. Carried on the
  // player so it survives RoomPersistence across a deploy.
  cloneExpiresAt?: number;
  // Wall-clock (Unix ms) the player's Cloak power-up stays active until. While
  // cloakUntil > now other clients hide this body. Visual only — the player
  // stays taggable and shootable server-side. Like surgeUntil it is never
  // cleared, just left in the past.
  cloakUntil?: number;
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
  // Available power-ups on the floor. Omitted when none are spawned. Items
  // are static, so they ride the snapshot; pickups/respawns arrive as events.
  items?: Item[];
  // Live portal pairs. Omitted when none are open. Like items they ride the
  // snapshot so a late joiner / reconnect sees an in-progress pair; open/close
  // transitions arrive as events.
  portals?: Portal[];
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
  // Fire a freeze projectile from the player's current position in
  // the (dirX, dirY, dirZ) direction. Client normalizes the vector
  // before sending. nowMs anchors the spawn timestamp the same way
  // input.nowMs does for jumps; server clamps to ±500 ms of its own
  // clock to bound client skew. Server enforces the cooldown.
  | { t: 'shoot'; dirX: number; dirY: number; dirZ: number; nowMs: number }
  // Private-lobby host transitions the room out of `filling` and into
  // `free_roam`. Server fills empty slots with bots on receipt and rejects
  // the message from any non-host player or when the phase is past
  // `filling`.
  | { t: 'start_match' }
  // Activate the held power-up. Server clears the slot and broadcasts
  // item_used; per-type effects are dispatched in later PRs. No-op when
  // the player holds nothing.
  | { t: 'use_item' };

export type ServerToClient =
  // sessionToken is the resumption secret for the recipient of this
  // snapshot only. Other clients never see this client's token. Stash
  // and send it on the next join after a WS drop to resume the same
  // PlayerState rather than spawning fresh.
  | { t: 'snapshot'; snapshot: RoomSnapshot; youAre: string; sessionToken: string }
  | {
      t: 'delta';
      players: PlayerState[];
      phase: RoomPhase;
      turnEndsAt: number;
      ackSeq: number;
      projectiles?: Projectile[];
    }
  | { t: 'event'; kind: GameEvent }
  | { t: 'tag_result'; ok: boolean; targetId?: string; reason?: string }
  | { t: 'unfreeze_result'; ok: boolean; targetId?: string; reason?: string }
  // Server-side ack for a shoot message. ok=false carries the reject
  // reason (`cooldown`, `wrong_turn`, `frozen`, `bad_direction`).
  | { t: 'shoot_result'; ok: boolean; projectileId?: string; reason?: string }
  | { t: 'pong'; serverTime: number; clientTime: number }
  | { t: 'error'; code: ErrorCode; message: string };

export type GameEvent =
  | { kind: 'tagged'; victimId: string; attackerId: string; team: Team }
  | { kind: 'saved'; victimId: string; saviorId: string }
  // cryIndex is the server-picked battle-cry slot for turn_mime / turn_clown
  // phases. All clients render the same cry by indexing into their local
  // MIME_BATTLE_CRIES / CLOWN_BATTLE_CRIES list. Omitted on non-turn phases.
  | { kind: 'phase'; phase: RoomPhase; cryIndex?: number }
  | { kind: 'win'; team: Team }
  // Projectile lifecycle. `fired` is broadcast for everyone to render
  // the trail/audio; `hit` is broadcast on impact (with the victim id
  // when the projectile hit a player, omitted when it hit a wall or
  // expired in flight). The freeze itself rides on the standard
  // 'tagged' event so existing handlers fire unchanged.
  | { kind: 'projectile_fired'; projectile: Projectile }
  | { kind: 'projectile_hit'; projectileId: string; victimId?: string }
  // Power-up lifecycle. `item_spawn` is broadcast when an available item
  // (re)appears after its respawn timer (the initial layout rides the
  // snapshot); `item_pickup` when a player grabs one; `item_used` when a
  // held power-up is activated.
  | { kind: 'item_spawn'; item: Item }
  | { kind: 'item_pickup'; itemId: string; playerId: string }
  | { kind: 'item_used'; playerId: string; itemType: ItemType }
  // Portal lifecycle. `portal_open` carries the new pair (also added to the
  // snapshot for late joiners); `portal_close` fires when the pair expires.
  | { kind: 'portal_open'; portal: Portal }
  | { kind: 'portal_close'; id: string };

export const BATTLE_CRY_COUNT = 8;

export type ErrorCode =
  | 'version_mismatch'
  | 'room_full'
  | 'room_not_found'
  | 'invalid_message'
  | 'rate_limited'
  | 'internal'
  | 'match_in_progress'
  | 'session_expired'
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
