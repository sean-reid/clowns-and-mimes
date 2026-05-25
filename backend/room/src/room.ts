import type {
  ClientToServer,
  PlayerInput,
  PlayerState,
  RoomPhase,
  RoomSnapshot,
  ServerToClient,
  Team,
  Topology,
} from '@cm/shared';
import { BATTLE_CRY_COUNT, PROTOCOL_VERSION } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedUnitDelta } from '@cm/shared/topology';
import { generateWalls, pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';
import {
  stepMovement,
  WALK_SPEED,
  SPRINT_SPEED,
  MAX_SPRINT,
  SPRINT_DRAIN_PER_S,
  SPRINT_REGEN_PER_S,
} from '@cm/shared/movement';
import { BotPathfinder } from './botPathfinder.ts';

// Server simulate + broadcast at 60 Hz. Each delta is ~16.7 ms apart so
// reconciliation corrections arrive 3x faster than the previous 20 Hz
// schedule and the snap each delta carries is correspondingly smaller. The
// 3x bandwidth increase is still well under 10 KB/s per client at typical
// roster sizes.
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
const FREE_ROAM_MS = 30_000;
// Two-radius tag/unfreeze model.
//
// BOT tags have no lag - server has current authoritative positions on both
// sides - so the strict radius matches the client's CONTACT_RADIUS (1.4).
// Any wider and bot tags feel like they fired from nowhere.
//
// CLIENT tags carry two compounding lags:
//   - Victim: ~50 ms snapshot interp lag.
//   - Attacker: the local player predicts movement client-side while the
//     server applies inputs at 20 Hz across another one-way trip. The
//     server's view of the attacker can run 100-200 ms behind the client's
//     predicted position; at SPRINT_SPEED (5.6 u/s) that is ~0.84 units.
// Combined, the server-side distance between attacker and a frozen
// teammate the client thinks is 1.4 away can read as 2.2+. Diagnostic
// playtest confirmed 'reason=out_of_range' at exactly that radius.
// 3.0 gives 1.6 units of headroom over CONTACT_RADIUS, covering the
// worst case the dev backend has shown. True bilateral lag compensation
// (rewind both sides to the client's tick from a trusted timestamp) is
// the right long-term fix but requires protocol work.
const TAG_RADIUS_BOT = 1.4;
const TAG_RADIUS_CLIENT = 3.0;
const UNFREEZE_RADIUS_BOT = 1.4;
const UNFREEZE_RADIUS_CLIENT = 3.0;
const WORLD_WIDTH = 80;
const MAX_PLAYERS = 16;
const TEAM_TARGET = 4;
// Movement constants and stepMovement are imported from @cm/shared/movement
// so the client predictor can call identical math during reconciliation.
const TURN_FIRST_MS = 30_000;
const TURN_STEP_MS = 30_000;
const TURN_CAP_MS = 5 * 60_000;
const BOT_FILL_DELAY_MS = 3_000;
// Wider vision so bots commit to a chase / flee instead of dithering on
// patrol when an opponent is across a corridor. World half-diagonal is ~56,
// so 22 covers most short corridors without making bots omniscient.
const BOT_VISION_RADIUS = 22;
const BOT_PATROL_RETARGET_MS = 4_000;
// Bots sprint when within this multiple of TAG_RADIUS of an engaged enemy
// (chase) or when fleeing and the threat is closing. Without sprint they
// were always walking and could never close on or escape a sprinting human.
const BOT_SPRINT_TRIGGER_RADIUS = 10;
// Grace window after an unfreeze where the saved player cannot be re-tagged.
// Without this, two opponents adjacent to a saved teammate could re-freeze
// them on the very next tick and trigger an endless freeze/save chain.
const UNFREEZE_GRACE_MS = 1_500;
// Lag compensation experiment was a red herring: tag-missed-out-of-range
// failures during playtest were not driven by client-server position drift.
// Rewinding the victim was making frozen-target unfreeze worse (frozen
// players don't move, so historical positions just took us further from
// where the client clicked save). Leave the helper plumbing in place but
// set the window to 0 so distance checks use current authoritative state.
// If lag-driven rejections come back in playtest, revisit with per-client
// RTT estimation off the existing ping/pong stream.
const LAG_COMP_MS = 0;
// Cap of how far back we keep positions. Larger means more memory but
// covers higher-latency clients; 500 ms is plenty for any reasonable RTT.
const POSITION_HISTORY_KEEP_MS = 500;

interface BotMind {
  patrolTarget: { x: number; z: number };
  patrolUntil: number;
  // Sticky chase/flee target. Without this, simulateBots picked the closest
  // enemy every tick - if two opponents were near-equidistant, the bot would
  // oscillate between them and the rendered motion looked like jitter. Once
  // a target is engaged we stay with it unless it disappears, becomes
  // invalid, or a different enemy is significantly closer.
  engagedTargetId: string | null;
  // Cached unit-direction vector for movement smoothing. Each tick lerps
  // toward the freshly-computed direction by SMOOTHING so abrupt
  // reversals (e.g. two opponents straddling the bot) don't translate into
  // visible flicker.
  lastDir: { x: number; z: number };
  // Most recent yaw the bot rendered. Body yaw is interpolated toward the
  // movement direction with a cap on radians-per-tick so cardinal slide
  // fallbacks don't snap the avatar 90 degrees in one frame.
  lastYaw: number;
}

interface Connection {
  ws: WebSocket;
  playerId: string;
}

/**
 * Subset of worker env the Room DO reads. MATCHMAKER_URL points at the
 * matchmaker worker; the Room posts roster-change notifications there so the
 * MatchmakerDO can keep accurate humans/bots counts for routing. Optional
 * because tests construct the Room without the binding wired.
 */
export interface RoomEnv {
  MATCHMAKER_URL?: string;
}

export class Room implements DurableObject {
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly players = new Map<string, PlayerState>();
  private readonly lastInputs = new Map<string, PlayerInput>();
  // Last input seq the server actually fed into stepMovement, per player.
  // Distinct from lastInputs.seq, which is the most recently received: an
  // input arriving between two ticks gets stored but only applied on the next
  // simulate call, so ackSeq must reflect what the simulation consumed.
  private readonly lastAppliedSeq = new Map<string, number>();
  private phase: RoomPhase = 'filling';
  private turnEndsAt = 0;
  private topology: Topology = 'plane';
  private seed = Math.floor(Math.random() * 2 ** 31);
  private roundNumber = 0;
  private firstTeam: Team = 'mime';
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private botFillHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly botMinds = new Map<string, BotMind>();
  // Wall-clock ms when each player was last unfrozen. Used by canTag to
  // refuse a re-tag inside UNFREEZE_GRACE_MS so adjacent attackers can't
  // start an immediate freeze/save oscillation.
  private readonly lastSavedAt = new Map<string, number>();
  // Recent server-authoritative positions, oldest first. Used by lag
  // compensation when validating client-initiated tag/unfreeze: the client
  // tagged based on a position the server held LAG_COMP_MS ago; we rewind
  // to that snapshot for the distance check.
  private readonly positionHistory = new Map<string, Array<{ t: number; x: number; z: number }>>();
  private walls: readonly WallSegment[] = [];
  // Grid BFS pathfinder. Rebuilt whenever walls regenerate (seed or topology
  // change). simulateBots queries nextWaypoint so chase / rescue targets get
  // routed around wall segments instead of grinding into them.
  private pathfinder: BotPathfinder | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RoomEnv = {},
  ) {
    this.walls = generateWalls(this.seed, this.topology);
    this.rebuildPathfinder();
  }

  private rebuildPathfinder(): void {
    this.pathfinder = new BotPathfinder(this.walls, this.topology);
  }

  /**
   * Best-effort POST to the matchmaker so its open-room counts stay current.
   * Called after every roster change (join, detach, fill, bot kick). The
   * matchmaker is global state outside the room's gameplay loop; if the
   * fetch fails or MATCHMAKER_URL is missing, gameplay continues unaffected.
   */
  private notifyMatchmaker(humans: number, bots: number): void {
    const base = this.env.MATCHMAKER_URL;
    if (!base) return;
    const roomId = this.state.id.toString();
    fetch(`${base}/lobby/room-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, humans, bots }),
    }).catch(() => {
      // best-effort; ignore failures
    });
  }

  /** Tell the matchmaker the room has emptied so it can drop the entry. */
  private detachMatchmaker(): void {
    const base = this.env.MATCHMAKER_URL;
    if (!base) return;
    const roomId = this.state.id.toString();
    fetch(`${base}/lobby/room-detach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId }),
    }).catch(() => {
      // best-effort
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // The matchmaker stamps the room's topology onto the WebSocket URL as a
    // ?topology= query param. Apply it before any client joins so the wall
    // set, snapshot, and bot behavior all match what the lobby selected.
    // First fetch wins: subsequent reconnects to the same room keep the
    // topology that was first applied.
    const url = new URL(req.url);
    const requestedTopology = url.searchParams.get('topology');
    if (requestedTopology && this.players.size === 0 && isValidTopology(requestedTopology)) {
      this.setTopology(requestedTopology);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      ) as ClientToServer;
    } catch {
      this.send(ws, { t: 'error', code: 'invalid_message', message: 'bad json' });
      return;
    }
    this.handleMessage(ws, msg);
  }

  webSocketClose(ws: WebSocket): void {
    this.detach(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.detach(ws);
  }

  private handleMessage(ws: WebSocket, msg: ClientToServer): void {
    switch (msg.t) {
      case 'join':
        this.onJoin(ws, msg.name, msg.v, msg.preferTeam);
        return;
      case 'leave':
        this.detach(ws);
        return;
      case 'input':
        this.onInput(ws, msg.input);
        return;
      case 'tag_attempt':
        this.onTag(ws, msg.targetId);
        return;
      case 'unfreeze_attempt':
        this.onUnfreeze(ws, msg.targetId);
        return;
      case 'ping':
        this.send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
        return;
    }
  }

  private onJoin(ws: WebSocket, name: string, version: number, prefer?: Team): void {
    if (version !== PROTOCOL_VERSION) {
      this.send(ws, { t: 'error', code: 'version_mismatch', message: 'update your client' });
      ws.close(4001, 'version');
      return;
    }
    if (this.humanPlayers().length >= MAX_PLAYERS - this.botPlayers().length) {
      this.send(ws, { t: 'error', code: 'room_full', message: 'room full' });
      ws.close(4002, 'full');
      return;
    }
    const id = crypto.randomUUID();
    const team = prefer ?? this.pickTeam();
    // Bot fill runs 3 s after the first human joins, so anyone arriving
    // later finds bots already occupying TEAM_TARGET slots. Drop one bot
    // from the joining player's team to make room for them, so the team
    // saturates with humans instead of staying bot-heavy when there are
    // people waiting to play.
    if (this.tally(team) >= TEAM_TARGET) {
      this.kickOneBotFromTeam(team);
    }
    const player: PlayerState = {
      id,
      name: this.sanitizeName(name),
      team,
      bot: false,
      position: this.pickSpawnPosition(team),
      yaw: 0,
      frozen: false,
      sprintEnergy: MAX_SPRINT,
      sprinting: false,
    };
    this.players.set(id, player);
    this.connections.set(ws, { ws, playerId: id });
    this.send(ws, { t: 'snapshot', snapshot: this.snapshot(), youAre: id });
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    if (this.phase === 'filling' && this.humanPlayers().length >= 2 && !this.tickHandle) {
      this.startMatch();
    } else if (this.phase === 'filling' && this.botFillHandle === null && !this.tickHandle) {
      this.scheduleBotFill();
    }
    this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
  }

  /** Schedule a one-shot bot fill so a solo joiner gets opponents within a few seconds. */
  private scheduleBotFill(): void {
    this.botFillHandle = setTimeout(() => {
      this.botFillHandle = null;
      if (this.phase !== 'filling' || this.tickHandle) return;
      this.fillBots();
      this.startMatch();
    }, BOT_FILL_DELAY_MS);
  }

  /** Fill empty slots with bots up to TEAM_TARGET per team. Idempotent. */
  fillBots(): void {
    for (const team of ['mime', 'clown'] as const) {
      while (this.tally(team) < TEAM_TARGET) {
        const id = crypto.randomUUID();
        this.players.set(id, {
          id,
          name: generateBotName(),
          team,
          bot: true,
          position: this.pickSpawnPosition(team),
          yaw: 0,
          frozen: false,
          sprintEnergy: MAX_SPRINT,
          sprinting: false,
        });
        this.botMinds.set(id, {
          patrolTarget: this.randomPatrolPoint(),
          patrolUntil: 0,
          engagedTargetId: null,
          lastDir: { x: 0, z: 0 },
          lastYaw: 0,
        });
      }
    }
    this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
  }

  private randomPatrolPoint(): { x: number; z: number } {
    const half = WORLD_WIDTH / 2;
    return {
      x: (Math.random() - 0.5) * 2 * (half - 4),
      z: (Math.random() - 0.5) * 2 * (half - 4),
    };
  }

  /**
   * Cells the bot should treat as solid for this tick's BFS. Used to route
   * chase / rescue paths around stationary bodies that would otherwise pin
   * the bot in a corridor (the slide-fallback can't side-step a body that
   * sits exactly across the desired axis). Excludes the bot itself and the
   * preserveId target so the destination cell remains walkable. Returns an
   * empty set when the pathfinder is missing.
   */
  private avoidCellsForBot(self: PlayerState, preserve: PlayerState | null): Set<number> {
    const out = new Set<number>();
    if (!this.pathfinder) return out;
    const preserveId = preserve ? preserve.id : null;
    for (const other of this.players.values()) {
      if (other.id === self.id) continue;
      if (other.id === preserveId) continue;
      out.add(this.pathfinder.cellAt(other.position));
    }
    return out;
  }

  /**
   * Returns true if landing at (x, z) would put this player inside another
   * player's personal space. Without this check, two bodies in the same
   * corridor push through each other every tick and the client renders the
   * back-and-forth as visible jitter. The threshold is two body radii plus
   * a small buffer so capsules never touch.
   */
  private collidesWithOtherPlayer(self: PlayerState, x: number, z: number): boolean {
    const PERSONAL_SPACE = 1.0; // 2 * PLAYER_RADIUS (0.4) + buffer
    for (const other of this.players.values()) {
      if (other.id === self.id) continue;
      const dx = other.position.x - x;
      const dz = other.position.z - z;
      if (dx * dx + dz * dz < PERSONAL_SPACE * PERSONAL_SPACE) return true;
    }
    return false;
  }

  /**
   * Pick a spawn point inside the team's open cell that does not overlap any
   * existing player. Tries up to 16 jitter samples; falls back to the last
   * sample if all are taken (the room is then so full that overlap is
   * unavoidable anyway).
   */
  private pickSpawnPosition(team: Team): { x: number; z: number } {
    const PERSONAL_SPACE_SQ = 1.0;
    let candidate = jitteredSpawn(team);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      let blocked = false;
      for (const other of this.players.values()) {
        const dx = other.position.x - candidate.x;
        const dz = other.position.z - candidate.z;
        if (dx * dx + dz * dz < PERSONAL_SPACE_SQ) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return candidate;
      candidate = jitteredSpawn(team);
    }
    return candidate;
  }

  setTopology(t: Topology): void {
    this.topology = t;
    // The wall set depends on topology now: torus/klein use a grid maze, the
    // others use concentric rings. Rebuild so pathCrossesWall checks against
    // the right geometry.
    this.walls = generateWalls(this.seed, t);
    this.rebuildPathfinder();
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.walls = generateWalls(seed, this.topology);
    this.rebuildPathfinder();
  }

  private detach(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    this.connections.delete(ws);
    this.players.delete(conn.playerId);
    this.lastInputs.delete(conn.playerId);
    this.lastAppliedSeq.delete(conn.playerId);
    this.lastSavedAt.delete(conn.playerId);
    this.positionHistory.delete(conn.playerId);
    if (this.humanPlayers().length === 0) {
      this.stopTick();
      this.cancelBotFill();
      this.clearBots();
      this.phase = 'filling';
      this.detachMatchmaker();
    } else {
      this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
    }
  }

  private cancelBotFill(): void {
    if (this.botFillHandle !== null) {
      clearTimeout(this.botFillHandle);
      this.botFillHandle = null;
    }
  }

  private clearBots(): void {
    for (const id of [...this.botMinds.keys()]) {
      this.players.delete(id);
    }
    this.botMinds.clear();
  }

  private onInput(ws: WebSocket, input: PlayerInput): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    this.lastInputs.set(conn.playerId, input);
  }

  private onTag(ws: WebSocket, targetId: string): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    const attacker = this.players.get(conn.playerId);
    const victim = this.players.get(targetId);
    if (!attacker || !victim) {
      this.send(ws, { t: 'tag_result', ok: false, reason: 'missing' });
      return;
    }
    const reason = this.tagRejectionReason(attacker, victim, TAG_RADIUS_CLIENT, true);
    if (reason !== null) {
      this.send(ws, { t: 'tag_result', ok: false, reason });
      return;
    }
    victim.frozen = true;
    this.send(ws, { t: 'tag_result', ok: true, targetId });
    this.broadcast({
      t: 'event',
      kind: { kind: 'tagged', attackerId: attacker.id, victimId: victim.id, team: attacker.team },
    });
    this.checkWin();
  }

  private onUnfreeze(ws: WebSocket, targetId: string): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    const savior = this.players.get(conn.playerId);
    const victim = this.players.get(targetId);
    if (!savior || !victim || !victim.frozen || savior.team !== victim.team) {
      this.send(ws, { t: 'unfreeze_result', ok: false, reason: 'invalid' });
      return;
    }
    // Lag-compensate the frozen teammate's position too: the client clicked
    // save based on where they saw the body, not where the server currently
    // has it. Frozen players don't move so this rarely matters, but staying
    // consistent with onTag keeps the rules simple.
    const victimPos = this.positionAt(victim.id, Date.now() - LAG_COMP_MS);
    const dist = topologyDistance(savior.position, victimPos, this.topology, WORLD_WIDTH);
    if (dist > UNFREEZE_RADIUS_CLIENT) {
      // Encode the actual distance in the reason so the client diagnostic
      // can show the magnitude of the gap (helps tune the radius without
      // wading through Workers logs).
      this.send(ws, {
        t: 'unfreeze_result',
        ok: false,
        reason: `out_of_range:${dist.toFixed(2)}`,
      });
      return;
    }
    if (
      this.walls.length > 0 &&
      pathCrossesWall(this.walls, savior.position.x, savior.position.z, victimPos.x, victimPos.z)
    ) {
      this.send(ws, { t: 'unfreeze_result', ok: false, reason: 'wall_in_way' });
      return;
    }
    victim.frozen = false;
    this.lastSavedAt.set(victim.id, Date.now());
    this.send(ws, { t: 'unfreeze_result', ok: true, targetId });
    this.broadcast({
      t: 'event',
      kind: { kind: 'saved', saviorId: savior.id, victimId: victim.id },
    });
  }

  /**
   * Returns null when the tag is legal, or a short reason string otherwise.
   * The reason is forwarded in tag_result so the HUD can surface why a tag
   * was rejected ('not_your_turn', 'out_of_range', 'wall_in_way', ...)
   * instead of just 'invalid'.
   *
   * lagCompensate is true for client-initiated tags only: the victim's
   * position is rewound by LAG_COMP_MS so the distance check runs against
   * the world state the client saw at the moment of the tag. Server-side
   * bot tags pass false because they have no lag to compensate for.
   */
  private tagRejectionReason(
    attacker: PlayerState,
    victim: PlayerState,
    radius: number,
    lagCompensate: boolean,
  ): string | null {
    if (attacker.team === victim.team) return 'same_team';
    if (attacker.frozen) return 'you_are_frozen';
    if (victim.frozen) return 'already_frozen';
    if (this.phase !== `turn_${attacker.team}`) return 'not_your_turn';
    const savedAt = this.lastSavedAt.get(victim.id);
    if (savedAt !== undefined && Date.now() - savedAt < UNFREEZE_GRACE_MS) return 'just_saved';
    const victimPos = lagCompensate
      ? this.positionAt(victim.id, Date.now() - LAG_COMP_MS)
      : victim.position;
    const d = topologyDistance(attacker.position, victimPos, this.topology, WORLD_WIDTH);
    if (d > radius) return `out_of_range:${d.toFixed(2)}`;
    if (
      this.walls.length > 0 &&
      pathCrossesWall(
        this.walls,
        attacker.position.x,
        attacker.position.z,
        victimPos.x,
        victimPos.z,
      )
    )
      return 'wall_in_way';
    return null;
  }

  private canTag(attacker: PlayerState, victim: PlayerState, radius: number): boolean {
    return this.tagRejectionReason(attacker, victim, radius, false) === null;
  }

  private tally(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n += 1;
    return n;
  }

  /**
   * Drop the first bot found on the given team, along with its bookkeeping.
   * Used when a human joins and the team is already at TEAM_TARGET capacity:
   * displacing a bot keeps the team-size budget intact while letting the
   * human in. The next broadcast delta carries the implicit removal, so
   * clients reap the bot's Player node via _sync_players_from_snapshot.
   */
  private kickOneBotFromTeam(team: Team): void {
    for (const [id, p] of this.players) {
      if (p.team === team && p.bot) {
        this.players.delete(id);
        this.botMinds.delete(id);
        this.lastSavedAt.delete(id);
        this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
        return;
      }
    }
  }

  private humanPlayers(): PlayerState[] {
    return [...this.players.values()].filter((p) => !p.bot);
  }

  private botPlayers(): PlayerState[] {
    return [...this.players.values()].filter((p) => p.bot);
  }

  private pickTeam(): Team {
    return this.tally('mime') <= this.tally('clown') ? 'mime' : 'clown';
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^\w \-.]/g, '').slice(0, 24) || 'Player';
  }

  private checkWin(): void {
    const mimesActive = [...this.players.values()].filter((p) => p.team === 'mime' && !p.frozen);
    const clownsActive = [...this.players.values()].filter((p) => p.team === 'clown' && !p.frozen);
    if (mimesActive.length === 0) {
      this.phase = 'ended';
      this.broadcast({ t: 'event', kind: { kind: 'win', team: 'clown' } });
      this.stopTick();
    } else if (clownsActive.length === 0) {
      this.phase = 'ended';
      this.broadcast({ t: 'event', kind: { kind: 'win', team: 'mime' } });
      this.stopTick();
    }
  }

  private startMatch(): void {
    this.firstTeam = Math.random() < 0.5 ? 'mime' : 'clown';
    this.phase = 'free_roam';
    this.turnEndsAt = Date.now() + FREE_ROAM_MS;
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    const now = Date.now();
    if (this.phase === 'free_roam' && now >= this.turnEndsAt) {
      this.beginNextTurn();
    } else if (
      (this.phase === 'turn_mime' || this.phase === 'turn_clown') &&
      now >= this.turnEndsAt
    ) {
      this.beginNextTurn();
    }
    this.simulate();
    this.broadcastDelta();
  }

  private beginNextTurn(): void {
    this.roundNumber += 1;
    const next: Team =
      this.phase === 'turn_mime' ? 'clown' : this.phase === 'turn_clown' ? 'mime' : this.firstTeam;
    this.phase = `turn_${next}` as RoomPhase;
    const ms = Math.min(TURN_CAP_MS, TURN_FIRST_MS + (this.roundNumber - 1) * TURN_STEP_MS);
    this.turnEndsAt = Date.now() + ms;
    // Pick the cry index once so every client renders the same banner text.
    // Each team has BATTLE_CRY_COUNT slots in their local cry array.
    const cryIndex = Math.floor(Math.random() * BATTLE_CRY_COUNT);
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase, cryIndex } });
  }

  /** Applies player inputs with anti-cheat distance clamping. */
  private simulate(): void {
    const dt = TICK_MS / 1000;
    this.simulateHumans(dt);
    this.simulateBots(dt);
    this.recordPositionsForLagComp();
  }

  /**
   * Append every player's current position to their history ring after each
   * tick, then drop entries older than POSITION_HISTORY_KEEP_MS. tagRejection
   * later rewinds the victim by LAG_COMP_MS so the server validates against
   * the world state the client saw at the moment of the tag.
   */
  private recordPositionsForLagComp(): void {
    const now = Date.now();
    const cutoff = now - POSITION_HISTORY_KEEP_MS;
    for (const p of this.players.values()) {
      let hist = this.positionHistory.get(p.id);
      if (!hist) {
        hist = [];
        this.positionHistory.set(p.id, hist);
      }
      hist.push({ t: now, x: p.position.x, z: p.position.z });
      while (hist.length > 0 && hist[0]!.t < cutoff) hist.shift();
    }
  }

  /** Closest historical position at or before atMs, or current if missing. */
  private positionAt(playerId: string, atMs: number): { x: number; z: number } {
    const hist = this.positionHistory.get(playerId);
    if (hist && hist.length > 0) {
      for (let i = hist.length - 1; i >= 0; i -= 1) {
        if (hist[i]!.t <= atMs) return { x: hist[i]!.x, z: hist[i]!.z };
      }
    }
    const p = this.players.get(playerId);
    return p ? { x: p.position.x, z: p.position.z } : { x: 0, z: 0 };
  }

  private simulateHumans(_dt: number): void {
    for (const [id, input] of this.lastInputs) {
      const p = this.players.get(id);
      if (!p || p.bot || p.frozen) continue;
      // Skip inputs we already consumed on a previous tick. Without this the
      // server re-runs stepMovement against the same input every tick the
      // client falls behind on sending, advancing the server-authoritative
      // position past where the client-side buffer ends. The next delta then
      // snaps the client backward and the user feels constant micro-jitter.
      const lastSeq = this.lastAppliedSeq.get(id) ?? -1;
      if (input.seq <= lastSeq) continue;
      const next = stepMovement(
        { position: p.position, sprintEnergy: p.sprintEnergy, sprinting: p.sprinting },
        // Use the dt the client reported with this input, not the server's
        // tick dt. Reconciliation replay on the client also drives
        // stepMovement from input.dt; if the two diverged the replayed
        // position would drift from the server's authoritative result.
        { move: input.move, sprint: input.sprint, dt: input.dt },
        this.walls,
        this.topology,
        WORLD_WIDTH,
        (candidate) => this.collidesWithOtherPlayer(p, candidate.x, candidate.z),
      );
      p.position = next.position;
      p.sprintEnergy = next.sprintEnergy;
      p.sprinting = next.sprinting;
      p.yaw = input.lookYaw;
      this.lastAppliedSeq.set(id, input.seq);
    }
  }

  private simulateBots(dt: number): void {
    const active = this.activeTurnTeam();
    const now = Date.now();
    // Heavier direction smoothing than before: bots used to flip heading the
    // moment a new candidate target appeared, which read as twitching at
    // tile-corners and around seams. 0.7 keeps most of the previous heading
    // and folds the new direction in over a few ticks instead of one.
    const DIR_SMOOTHING = 0.7;
    // Cap on body rotation per tick. At TICK_HZ=20 this is ~5 rad/s, fast
    // enough to chase a juking human but slow enough that slide-fallback
    // axis flips don't snap the avatar 90 degrees in one frame.
    const MAX_YAW_RATE = 5.0;
    const RETARGET_HYSTERESIS = 0.75; // new target must be this fraction of current distance to swap
    for (const bot of this.botPlayers()) {
      if (bot.frozen) continue;
      const mind = this.botMinds.get(bot.id) ?? {
        patrolTarget: this.randomPatrolPoint(),
        patrolUntil: 0,
        engagedTargetId: null,
        lastDir: { x: 0, z: 0 },
        lastYaw: bot.yaw,
      };
      this.botMinds.set(bot.id, mind);

      // Sticky target: stay engaged with whoever we picked last tick unless
      // they vanish or a new candidate is significantly closer. Without this
      // the bot would flip every tick between two near-equidistant enemies.
      const candidate = this.nearestVisibleEnemy(bot);
      const candidateDist = candidate
        ? topologyDistance(bot.position, candidate.position, this.topology, WORLD_WIDTH)
        : Infinity;
      let target: PlayerState | null = candidate;
      let enemyDist = candidateDist;
      if (mind.engagedTargetId) {
        const existing = this.players.get(mind.engagedTargetId);
        if (existing && !existing.frozen && existing.team !== bot.team) {
          const existingDist = topologyDistance(
            bot.position,
            existing.position,
            this.topology,
            WORLD_WIDTH,
          );
          // Keep existing unless the new candidate is at least
          // RETARGET_HYSTERESIS x closer.
          if (
            existingDist < BOT_VISION_RADIUS &&
            candidateDist >= existingDist * RETARGET_HYSTERESIS
          ) {
            target = existing;
            enemyDist = existingDist;
          }
        }
      }
      mind.engagedTargetId = target ? target.id : null;

      // Scan for a frozen teammate to rescue. Rescue is allowed in any phase
      // (unlike tagging) so we always consider it. Priority later: flee >
      // rescue > chase > patrol.
      let rescueTarget: PlayerState | null = null;
      let rescueDist = Infinity;
      for (const other of this.players.values()) {
        if (other.id === bot.id) continue;
        if (other.team !== bot.team) continue;
        if (!other.frozen) continue;
        const d = topologyDistance(bot.position, other.position, this.topology, WORLD_WIDTH);
        if (d < BOT_VISION_RADIUS && d < rescueDist) {
          rescueDist = d;
          rescueTarget = other;
        }
      }

      const chasing = target !== null && enemyDist < BOT_VISION_RADIUS && active === bot.team;
      const fleeing =
        target !== null && enemyDist < BOT_VISION_RADIUS && active && active !== bot.team;
      const rescuing = rescueTarget !== null;

      let dir = { x: 0, z: 0 };
      if (fleeing && target) {
        // Survival first. A bot chased by an active-turn enemy runs even if
        // a teammate is frozen nearby.
        const away = wrappedUnitDelta(target.position, bot.position, this.topology, WORLD_WIDTH);
        dir = away;
      } else if (rescuing && rescueTarget) {
        // BFS-route around walls toward the frozen teammate. The pathfinder
        // returns the world-space center of the next cell along the shortest
        // path; if from/to share a cell or are directly adjacent it returns
        // the destination unchanged, so the slide-fallback below still does
        // the final approach. Build an avoid set of every OTHER player's
        // cell (excluding the rescue target itself) so a frozen enemy
        // standing in the corridor between the bot and the teammate is
        // routed around instead of crashing into it - that case used to
        // leave the bot stuck in place, with the slide-fallback retrying
        // every tick.
        const avoid = this.avoidCellsForBot(bot, rescueTarget);
        const waypoint = this.pathfinder
          ? this.pathfinder.nextWaypointAvoiding(bot.position, rescueTarget.position, avoid)
          : rescueTarget.position;
        dir = wrappedUnitDelta(bot.position, waypoint, this.topology, WORLD_WIDTH);
      } else if (chasing && target) {
        // Same BFS routing for chase, with the same other-player avoidance:
        // a frozen teammate in the chase lane should be routed around
        // instead of pinning the bot. The chase target stays walkable.
        const avoid = this.avoidCellsForBot(bot, target);
        const waypoint = this.pathfinder
          ? this.pathfinder.nextWaypointAvoiding(bot.position, target.position, avoid)
          : target.position;
        dir = wrappedUnitDelta(bot.position, waypoint, this.topology, WORLD_WIDTH);
      } else {
        if (now >= mind.patrolUntil || nearTarget(bot.position, mind.patrolTarget)) {
          mind.patrolTarget = this.randomPatrolPoint();
          mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
        }
        dir = wrappedUnitDelta(bot.position, mind.patrolTarget, this.topology, WORLD_WIDTH);
      }
      // Smooth direction toward the freshly-computed dir. Stops the bot from
      // snapping to a new heading every tick when the AI is indecisive.
      dir = {
        x: mind.lastDir.x * DIR_SMOOTHING + dir.x * (1 - DIR_SMOOTHING),
        z: mind.lastDir.z * DIR_SMOOTHING + dir.z * (1 - DIR_SMOOTHING),
      };
      const dirLen = Math.hypot(dir.x, dir.z);
      if (dirLen > 1e-3) {
        dir = { x: dir.x / dirLen, z: dir.z / dirLen };
      } else {
        dir = { x: 0, z: 0 };
      }
      mind.lastDir = dir;

      // Bots sprint when engaged and the target is within striking distance,
      // assuming they have energy. Without this they only ever walked and a
      // sprinting human could never be caught or escape from. Rescues also
      // trigger sprint when close to a frozen teammate so saves don't take
      // forever.
      const closeEnemyOrRescue =
        (chasing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (fleeing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (rescuing && rescueDist < BOT_SPRINT_TRIGGER_RADIUS);
      const wantSprint = closeEnemyOrRescue && bot.sprintEnergy > MAX_SPRINT * 0.15;
      const speed = wantSprint ? SPRINT_SPEED : WALK_SPEED;
      const step = speed * dt;
      // Try the straight-ahead move first. If a wall blocks it, try sliding
      // along each axis (X-only, then Z-only). A bot chasing through a maze
      // corridor used to dance in place because the direct line to the
      // target ran into a wall every tick.
      const candidates: Array<{ x: number; z: number; chosen: { x: number; z: number } }> = [
        {
          x: bot.position.x + dir.x * step,
          z: bot.position.z + dir.z * step,
          chosen: dir,
        },
        {
          x: bot.position.x + Math.sign(dir.x) * step,
          z: bot.position.z,
          chosen: { x: Math.sign(dir.x), z: 0 },
        },
        {
          x: bot.position.x,
          z: bot.position.z + Math.sign(dir.z) * step,
          chosen: { x: 0, z: Math.sign(dir.z) },
        },
      ];
      let moved = false;
      for (const candidate of candidates) {
        if (candidate.chosen.x === 0 && candidate.chosen.z === 0) continue;
        const wallBlocked =
          this.walls.length > 0 &&
          pathCrossesWall(this.walls, bot.position.x, bot.position.z, candidate.x, candidate.z);
        if (wallBlocked) continue;
        if (this.collidesWithOtherPlayer(bot, candidate.x, candidate.z)) continue;
        bot.position = wrapPosition({ x: candidate.x, z: candidate.z }, this.topology, WORLD_WIDTH);
        moved = true;
        break;
      }
      // Body yaw follows the smoothed movement direction, capped by
      // MAX_YAW_RATE so a slide-fallback that mostly moves on z (when the
      // straight-ahead candidate is wall-blocked) doesn't snap the avatar
      // 90 degrees in a single tick.
      if (dir.x !== 0 || dir.z !== 0) {
        const desiredYaw = Math.atan2(-dir.x, -dir.z);
        let delta = desiredYaw - mind.lastYaw;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const maxStep = MAX_YAW_RATE * dt;
        const clamped = Math.max(-maxStep, Math.min(maxStep, delta));
        mind.lastYaw += clamped;
        bot.yaw = mind.lastYaw;
      } else {
        mind.lastYaw = bot.yaw;
      }
      if (!moved) {
        // Pinned on every axis. Two cases: the bot is in a tight corner
        // bounded by walls on all sides, or it has somehow ended up with
        // its center inside a wall (in which case every candidate stays
        // inside the wall too). Detect the second case with a zero-length
        // pathCrossesWall against the current position - if the bot's
        // center is already within clearance of a wall, no nudge will get
        // it out. Teleport it back to a known-safe spawn cell.
        if (
          this.walls.length > 0 &&
          pathCrossesWall(
            this.walls,
            bot.position.x,
            bot.position.z,
            bot.position.x,
            bot.position.z,
          )
        ) {
          bot.position = jitteredSpawn(bot.team);
        }
        mind.patrolTarget = this.randomPatrolPoint();
        mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
      }

      // Bot tag: strict radius, no lag to compensate for. canTag also blocks
      // through-wall tags so a bot can't freeze someone on the other side of
      // a maze segment.
      if (
        chasing &&
        target &&
        enemyDist <= TAG_RADIUS_BOT &&
        this.canTag(bot, target, TAG_RADIUS_BOT)
      ) {
        target.frozen = true;
        this.broadcast({
          t: 'event',
          kind: { kind: 'tagged', attackerId: bot.id, victimId: target.id, team: bot.team },
        });
        this.checkWin();
      }

      // Bot rescue: when a frozen teammate is within UNFREEZE_RADIUS_BOT and
      // not blocked by a wall, unfreeze them. Mirrors what a human would do
      // via the onUnfreeze handler.
      if (
        rescuing &&
        rescueTarget &&
        rescueDist <= UNFREEZE_RADIUS_BOT &&
        (this.walls.length === 0 ||
          !pathCrossesWall(
            this.walls,
            bot.position.x,
            bot.position.z,
            rescueTarget.position.x,
            rescueTarget.position.z,
          ))
      ) {
        rescueTarget.frozen = false;
        this.lastSavedAt.set(rescueTarget.id, Date.now());
        this.broadcast({
          t: 'event',
          kind: { kind: 'saved', saviorId: bot.id, victimId: rescueTarget.id },
        });
      }

      // Mirror the human sprint energy model so a bot that just sprinted has
      // to recover before sprinting again. Otherwise the bot would sprint
      // forever and never catch its breath.
      bot.sprintEnergy = clamp(
        bot.sprintEnergy + (wantSprint && moved ? -SPRINT_DRAIN_PER_S : SPRINT_REGEN_PER_S) * dt,
        0,
        MAX_SPRINT,
      );
    }
  }

  private nearestVisibleEnemy(bot: PlayerState): PlayerState | null {
    let best: PlayerState | null = null;
    let bestDist = Infinity;
    for (const other of this.players.values()) {
      if (other.id === bot.id) continue;
      if (other.team === bot.team) continue;
      if (other.frozen) continue;
      const d = topologyDistance(bot.position, other.position, this.topology, WORLD_WIDTH);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
  }

  private activeTurnTeam(): Team | null {
    if (this.phase === 'turn_mime') return 'mime';
    if (this.phase === 'turn_clown') return 'clown';
    return null;
  }

  private broadcastDelta(): void {
    const players = [...this.players.values()];
    for (const conn of this.connections.values()) {
      this.send(conn.ws, {
        t: 'delta',
        players,
        phase: this.phase,
        turnEndsAt: this.turnEndsAt,
        // ackSeq is the seq of the input most recently applied in
        // simulateHumans, not the most recently received. The client uses
        // this to know which buffered inputs to drop and which to replay
        // when reconciling its predicted position with the server's truth.
        ackSeq: this.lastAppliedSeq.get(conn.playerId) ?? 0,
      });
    }
  }

  private snapshot(): RoomSnapshot {
    return {
      v: PROTOCOL_VERSION,
      roomId: this.state.id.toString(),
      seed: this.seed,
      topology: this.topology,
      phase: this.phase,
      turnEndsAt: this.turnEndsAt,
      players: [...this.players.values()],
    };
  }

  private broadcast(msg: ServerToClient): void {
    for (const conn of this.connections.values()) {
      this.send(conn.ws, msg);
    }
  }

  private send(ws: WebSocket, msg: ServerToClient): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket likely closed; cleanup happens on close event
    }
  }

  private stopTick(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isValidTopology(value: string): value is Topology {
  return value === 'plane' || value === 'torus' || value === 'klein' || value === 'genus2';
}

function nearTarget(
  from: { x: number; z: number },
  to: { x: number; z: number },
  threshold = 1.4,
): boolean {
  return Math.hypot(to.x - from.x, to.z - from.z) <= threshold;
}

// Team spawn centers sit in the interior of a grid-maze cell so the jitter
// stays clear of wall seams. Cell centers in a 10x10 grid (cell size 8) are at
// every (+-4 + k*8) coord; mimes get (-12, 4) and clowns (12, 4) - two cells
// apart in the x direction, both well off the origin grid line.
function jitteredSpawn(team: Team): { x: number; z: number } {
  const center = team === 'mime' ? { x: -12, z: 4 } : { x: 12, z: 4 };
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * 2.5;
  return {
    x: center.x + Math.cos(angle) * radius,
    z: center.z + Math.sin(angle) * radius,
  };
}

// Mirror of game/scripts/username_generator.gd. Bots get the same flavor of
// silly name human players generate locally, so the team status row reads as
// a cast of characters instead of "Bot-1a2b / Bot-3c4d". The lists are kept
// short (28 each) so a single file stays a reasonable size; the full client
// lists are not required for parity since bot names are server-authored only.
const BOT_NAME_ADJECTIVES = [
  'Silent',
  'Painted',
  'Loud',
  'Floppy',
  'Crooked',
  'Bashful',
  'Velvet',
  'Hushed',
  'Ruffled',
  'Striped',
  'Glossy',
  'Pale',
  'Sneaky',
  'Whiskered',
  'Brittle',
  'Tipsy',
  'Polka',
  'Wobbly',
  'Crinkled',
  'Powdered',
  'Squeaky',
  'Tufted',
  'Knobbly',
  'Frilly',
  'Wonky',
  'Boggled',
  'Plucky',
  'Drooping',
];

const BOT_NAME_NOUNS = [
  'Bozo',
  'Coulrophobe',
  'Pierrot',
  'Harlequin',
  'Buffoon',
  'Jester',
  'Marceau',
  'Tramp',
  'Auguste',
  'Whiteface',
  'Carnie',
  'Pagliacci',
  'Punchinello',
  'Hopo',
  'Cake',
  'Honk',
  'Greasepaint',
  'Stripes',
  'Tear',
  'Glove',
  'Wig',
  'Nose',
  'Shoe',
  'Banana',
  'Pinwheel',
  'Smile',
  'Frown',
  'Lapel',
];

function generateBotName(): string {
  const adj = BOT_NAME_ADJECTIVES[Math.floor(Math.random() * BOT_NAME_ADJECTIVES.length)]!;
  const noun = BOT_NAME_NOUNS[Math.floor(Math.random() * BOT_NAME_NOUNS.length)]!;
  const num = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return `${adj}${noun}${num}`;
}
