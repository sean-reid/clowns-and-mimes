import type {
  ClientToServer,
  PlayerInput,
  PlayerState,
  RoomPhase,
  RoomSnapshot,
  ServerToClient,
  Team,
  Topology,
  Vec3,
} from '@cm/shared';
import { PROTOCOL_VERSION } from '@cm/shared';
import { HOVER_HEIGHT } from '@cm/shared/physics';
import {
  generateWalls,
  pointBlockedByWall,
  PLAYER_RADIUS,
  type WallSegment,
} from '@cm/shared/labyrinth';
import { balanceTeamAssignments } from './teamBalance.ts';
import { MAX_SPRINT } from '@cm/shared/movement';
import { BotManager, type BotManagerHost } from './botManager.ts';
import { BotPathfinder } from './botPathfinder.ts';
import { GameSimulation, type GameSimulationHost } from './gameSimulation.ts';
import { parseClientMessage } from './messageValidator.ts';
import { RateLimiter } from './rateLimiter.ts';
import { RoomPersistence, type PersistedRoomState } from './roomPersistence.ts';
import { SessionManager } from './sessionManager.ts';
import { SnapshotBroadcaster, type SnapshotBroadcasterHost } from './snapshotBroadcaster.ts';
import { TagManager, type TagManagerHost } from './tagManager.ts';

// Server simulate + broadcast at 60 Hz. Each delta is ~16.7 ms apart so
// reconciliation corrections arrive 3x faster than the previous 20 Hz
// schedule and the snap each delta carries is correspondingly smaller. The
// 3x bandwidth increase is still well under 10 KB/s per client at typical
// roster sizes.
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
// Per-player input-queue cap. The client streams inputs at TICK_HZ so the
// steady-state queue size is 0 or 1. Allow a few ticks of headroom so a
// network jitter burst is absorbed instead of dropping inputs at the door;
// past this limit the OLDEST is dropped so the simulation does not lag
// further behind live time.
const MAX_INPUT_QUEUE = 4;
// Per-WebSocket rate-limit budget. 120 msg burst, 60/s sustained.
// At TICK_HZ=60 the steady-state client sends ~60 inputs/s plus
// occasional ping/tag/etc; this caps a flooding client to roughly
// the same cadence while letting a brief jitter burst through.
const RATE_LIMIT_CAPACITY = 120;
const RATE_LIMIT_REFILL_PER_MS = 0.06;
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
const TAG_RADIUS_CLIENT = 3.0;
const UNFREEZE_RADIUS_CLIENT = 3.0;
const WORLD_WIDTH = 80;
const MAX_PLAYERS = 16;
// Per-team bot fill target. Matches the TEAM_TARGET inside BotManager;
// kept here because onJoin reads it to decide whether to kick a bot when
// a human arrives after the auto-fill has saturated the team.
const TEAM_TARGET = 4;
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
  // Per-WebSocket host token, captured from the `?host=<token>` query param
  // on the WS upgrade URL. Set by the matchmaker only on the host's URL
  // (joinByCode never returns it). When the `join` message arrives over
  // this socket, the room marks that connection's player as the host.
  private readonly hostTokenByWs = new Map<WebSocket, string>();
  // First host token seen on a WS upgrade for this room. Locked-in so
  // a malicious second client constructing a different host URL cannot
  // hijack the role.
  private expectedHostToken: string | null = null;
  // Player id of the host once they have completed the `join` handshake.
  // Used to gate `start_match` to that one player.
  private hostPlayerId: string | null = null;
  // Session tokens + disconnect-grace timers live in SessionManager.
  // See backend/room/src/sessionManager.ts.
  private readonly sessions = new SessionManager();
  // One queue per player. Inputs arrive at 60 Hz from the client and are
  // drained one-per-tick by simulateHumans (matching the canonical Quake /
  // Source / Overwatch model). The cap (MAX_INPUT_QUEUE) bounds memory if a
  // bursting client outpaces the tick; an overflow drops the OLDEST so the
  // simulation stays close to live time rather than running on stale inputs.
  private readonly inputQueues = new Map<string, PlayerInput[]>();
  // Last input seq the server actually fed into stepMovement, per player.
  // This is what gets reported back to the client as ackSeq so reconciliation
  // replays only the inputs the simulation has not yet consumed.
  private readonly lastAppliedSeq = new Map<string, number>();
  private phase: RoomPhase = 'filling';
  private turnEndsAt = 0;
  private topology: Topology = 'plane';
  private seed = Math.floor(Math.random() * 2 ** 31);
  private roundNumber = 0;
  private firstTeam: Team = 'mime';
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  // Each player's XZ position as of the start of the current tick.
  // resolvePlayerCollisions uses this to derive an approach speed
  // between two bodies (so the bounce-back impulse can scale with
  // closing velocity). Updated at the end of every simulate() pass
  // from the post-tick positions, so the NEXT tick's collision pass
  // sees the right "where each player was".
  private readonly prevTickPositions = new Map<string, { x: number; z: number }>();
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
  private readonly tagManager: TagManager;
  private readonly broadcaster: SnapshotBroadcaster;
  private readonly bots: BotManager;
  private readonly sim: GameSimulation;
  // One token bucket per live WebSocket. Created on accept, removed on
  // detach. webSocketMessage rejects with a rate_limited error when the
  // bucket is empty; the connection stays open so a transient burst
  // doesn't force a reconnect cycle.
  private readonly rateLimiters = new Map<WebSocket, RateLimiter>();
  // Persists room state across DO restarts (wrangler deploys, CF
  // migrations, crashes). Loaded once on construct via
  // blockConcurrencyWhile so the first incoming WS message sees the
  // restored state. Saved fire-and-forget on every state-changing event
  // via persist(); CF DO storage coalesces writes within an I/O turn.
  private readonly persistence: RoomPersistence;
  // Logical room id used as the matchmaker's openRooms key. Parsed from
  // the /ws/{uuid} fetch URL on first upgrade. We can't use
  // state.id.toString() here because that returns the 64-char hash CF
  // computes from idFromName(uuid), which doesn't match the UUID the
  // matchmaker minted in /openJoin. Before this field existed the room
  // was reporting the hash and the matchmaker's roomState/roomDetach
  // lookups silently missed every entry - they only ever pruned on the
  // 5-minute lastSeenAt cutoff. Falls back to state.id.toString() for
  // safety; never read by the matchmaker fallback path.
  private matchmakerRoomId: string | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RoomEnv = {},
  ) {
    this.persistence = new RoomPersistence(state.storage);
    // Restore in-memory state from a prior DO incarnation, if any.
    // blockConcurrencyWhile guarantees no WS message is dispatched until
    // this resolves, so the first onJoin sees the full restored snapshot
    // (players map populated, sessionTokens primed, pending graces armed).
    // walls + pathfinder are generated INSIDE the block, AFTER any
    // restore, so they use the persisted (seed, topology) - generating
    // them outside the block would race with the restore and leave the
    // pathfinder pointed at the wrong walls.
    state.blockConcurrencyWhile(async () => {
      const persisted = await this.persistence.load();
      if (persisted !== null) this.restoreFromSnapshot(persisted);
      this.walls = generateWalls(this.seed, this.topology);
      this.rebuildPathfinder();
    });
    const broadcasterHost: SnapshotBroadcasterHost = {
      players: this.players,
      connections: this.connections,
      lastAppliedSeq: this.lastAppliedSeq,
      getPhase: () => this.phase,
      getTurnEndsAt: () => this.turnEndsAt,
      getSeed: () => this.seed,
      getTopology: () => this.topology,
      getRoomId: () => this.state.id.toString(),
    };
    this.broadcaster = new SnapshotBroadcaster(broadcasterHost);
    const host: TagManagerHost = {
      players: this.players,
      lastSavedAt: this.lastSavedAt,
      connections: this.connections,
      worldWidth: WORLD_WIDTH,
      unfreezeGraceMs: UNFREEZE_GRACE_MS,
      unfreezeRadiusClient: UNFREEZE_RADIUS_CLIENT,
      lagCompMs: LAG_COMP_MS,
      getWalls: () => this.walls,
      getTopology: () => this.topology,
      getPhase: () => this.phase,
      setPhase: (p) => {
        this.phase = p;
        this.persist();
      },
      positionAt: (id, atMs) => this.sim.positionAt(id, atMs),
      broadcast: (msg) => this.broadcast(msg),
      send: (ws, msg) => this.send(ws, msg),
      stopTick: () => this.stopTick(),
    };
    this.tagManager = new TagManager(host);
    const botsHost: BotManagerHost = {
      players: this.players,
      lastSavedAt: this.lastSavedAt,
      getWalls: () => this.walls,
      getTopology: () => this.topology,
      getPathfinder: () => this.pathfinder,
      getActiveTurnTeam: () => this.activeTurnTeam(),
      getPhase: () => this.phase,
      getTickHandle: () => this.tickHandle,
      pickSpawnPosition: (team) => this.pickSpawnPosition(team),
      tally: (team) => this.tally(team),
      humanCount: () => this.humanPlayers().length,
      botCount: () => this.botPlayers().length,
      notifyMatchmaker: (humans, bots) => this.notifyMatchmaker(humans, bots),
      broadcast: (msg) => this.broadcast(msg),
      canTag: (a, v, r) => this.tagManager.canTag(a, v, r),
      freezePlayer: (p) => this.tagManager.freezePlayer(p),
      checkWin: () => this.tagManager.checkWin(),
      startMatch: () => this.startMatch(),
    };
    this.bots = new BotManager(botsHost);
    const simHost: GameSimulationHost = {
      players: this.players,
      inputQueues: this.inputQueues,
      lastAppliedSeq: this.lastAppliedSeq,
      prevTickPositions: this.prevTickPositions,
      positionHistory: this.positionHistory,
      getWalls: () => this.walls,
      getTopology: () => this.topology,
      getPhase: () => this.phase,
      setPhase: (p) => {
        this.phase = p;
        this.persist();
      },
      getTurnEndsAt: () => this.turnEndsAt,
      setTurnEndsAt: (ms) => {
        this.turnEndsAt = ms;
      },
      // turnEndsAt updates every tick during simulation (the pause-resume
      // adjustment in particular). We don't persist on the simulation
      // tick to avoid 60 writes/sec; turnEndsAt restores to its
      // last-event-time value, which is good enough to ~1 s.
      getFirstTeam: () => this.firstTeam,
      getRoundNumber: () => this.roundNumber,
      incrementRoundNumber: () => {
        this.roundNumber += 1;
      },
      activeHumans: () => this.activeHumans(),
      simulateBots: (dt) => this.bots.simulate(dt),
      broadcast: (msg) => this.broadcast(msg),
      broadcastDelta: () => this.broadcaster.broadcastDelta(),
    };
    this.sim = new GameSimulation(simHost);
  }

  private rebuildPathfinder(): void {
    this.pathfinder = new BotPathfinder(this.walls, this.topology);
  }

  /**
   * Restore the in-memory room from a prior DO incarnation's persisted
   * snapshot. Called once from the constructor inside
   * blockConcurrencyWhile so all fields are populated before the first
   * WS message dispatches.
   *
   * Behaviour after a wrangler-deploy DO restart:
   *  - phase / seed / topology / host fields snap back to the prior
   *    values, so the resumed client sees the same match.
   *  - Every player (humans + bots) is restored at their last-persisted
   *    position. Positions update on events (join/detach/phase/tag),
   *    not on every tick, so they may be a few seconds stale.
   *  - sessionTokens are reinstalled, so the client's existing token
   *    resolves on the next join and resumeSession runs.
   *  - In-flight grace windows resume with their remaining time, or
   *    finalize immediately if the wall-clock already ran past the
   *    deadline while the DO was offline.
   *  - The tick is re-armed if the room was past the filling phase so
   *    the simulation continues the moment the first human reconnects
   *    (it pauses internally while activeHumans === 0).
   */
  private restoreFromSnapshot(s: PersistedRoomState): void {
    this.phase = s.phase;
    this.turnEndsAt = s.turnEndsAt;
    this.topology = s.topology;
    this.seed = s.seed;
    this.roundNumber = s.roundNumber;
    this.firstTeam = s.firstTeam;
    this.expectedHostToken = s.expectedHostToken;
    this.hostPlayerId = s.hostPlayerId;
    for (const p of s.players) this.players.set(p.id, p);
    for (const [id, token] of s.sessions) this.sessions.restore(id, token);
    const now = Date.now();
    for (const [id, expiresAt] of s.pendingDisconnects) {
      const remaining = expiresAt - now;
      if (remaining <= 0) {
        // Grace already expired while the DO was offline. Run the
        // teardown synchronously so the restored room matches what
        // would have happened had the DO stayed up.
        this.finalizeDisconnect(id);
      } else {
        this.sessions.scheduleFinalize(id, () => this.finalizeDisconnect(id), remaining);
      }
    }
    // Re-arm the tick if the match was running. The sim pauses
    // internally while activeHumans === 0 (every human is in grace
    // post-restore), so the first reconnect's resumeSession cancels
    // that player's grace and the sim resumes from the next tick.
    if (this.phase !== 'filling' && this.tickHandle === null && this.players.size > 0) {
      this.tickHandle = setInterval(() => this.sim.tick(), TICK_MS);
    }
  }

  /**
   * Serialize the current room into the persistence schema and write
   * it. Called at every state-changing event (join, detach, finalize,
   * resume, phase transition, bot fill, team balance). CF DO storage
   * coalesces multiple put()s within an I/O turn into one disk write,
   * so a tick that triggers several persist()s still costs one write.
   */
  private persist(): void {
    this.persistence.save({
      version: 1,
      phase: this.phase,
      turnEndsAt: this.turnEndsAt,
      topology: this.topology,
      seed: this.seed,
      roundNumber: this.roundNumber,
      firstTeam: this.firstTeam,
      expectedHostToken: this.expectedHostToken,
      hostPlayerId: this.hostPlayerId,
      players: [...this.players.values()],
      sessions: this.sessions.exportSessions(),
      pendingDisconnects: this.sessions.exportPendingDisconnects(),
    });
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
    // The matchmaker's open-room pool exists to send fresh strangers
    // somewhere they can actually join. The moment the room leaves
    // `filling`, onJoin starts rejecting new joins with
    // match_in_progress, so the room must come OUT of the pool. Without
    // this, the matchmaker keeps handing our wsUrl to strangers based
    // on humans+bots < soft capacity, and they all bounce off with a
    // close-4003 in the HUD. Re-attach is handled implicitly: when the
    // room eventually returns to `filling` (humans hit zero → bots
    // cleared → phase reset in finalizeDisconnect) the next onJoin's
    // notifyMatchmaker call lands here with phase==='filling' and the
    // entry re-appears in the pool.
    if (this.phase !== 'filling') {
      this.detachMatchmaker();
      return;
    }
    const roomId = this.matchmakerRoomId ?? this.state.id.toString();
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
    const roomId = this.matchmakerRoomId ?? this.state.id.toString();
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
    // Capture the logical room id (the UUID the matchmaker minted) from
    // the /ws/{uuid} path. We need this for notifyMatchmaker /
    // detachMatchmaker to address the correct openRooms entry; using
    // state.id.toString() instead would send the CF-computed hash and
    // every matchmaker mutation would silently miss the entry.
    if (this.matchmakerRoomId === null) {
      const m = url.pathname.match(/^\/ws\/([0-9a-f-]+)$/i);
      if (m) this.matchmakerRoomId = m[1]!;
    }
    const requestedTopology = url.searchParams.get('topology');
    if (requestedTopology && this.players.size === 0 && isValidTopology(requestedTopology)) {
      this.setTopology(requestedTopology);
    }
    // Matchmaker stamps the host's URL with `?host=<token>` on private
    // lobby create. The first such token a room sees becomes the room's
    // expectedHostToken; subsequent host-flavoured URLs with a different
    // token (only possible via a misconfiguration) are ignored.
    const hostToken = url.searchParams.get('host');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (hostToken) {
      if (this.expectedHostToken === null) {
        this.expectedHostToken = hostToken;
      }
      // Stash per-WS so the `join` handler can recognize this client as
      // the host without trusting payload-only fields.
      this.hostTokenByWs.set(server, hostToken);
    }
    this.state.acceptWebSocket(server);
    this.rateLimiters.set(
      server,
      new RateLimiter({ capacity: RATE_LIMIT_CAPACITY, refillPerMs: RATE_LIMIT_REFILL_PER_MS }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    const limiter = this.rateLimiters.get(ws);
    if (limiter && !limiter.tryConsume()) {
      this.send(ws, { t: 'error', code: 'rate_limited', message: 'too many messages' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      this.send(ws, { t: 'error', code: 'invalid_message', message: 'bad json' });
      return;
    }
    const msg = parseClientMessage(parsed);
    if (msg === null) {
      this.send(ws, { t: 'error', code: 'invalid_message', message: 'bad payload' });
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
        this.onJoin(ws, msg.name, msg.v, msg.preferTeam, msg.hostToken, msg.sessionToken);
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
      case 'start_match':
        this.onStartMatch(ws);
        return;
    }
  }

  private onJoin(
    ws: WebSocket,
    name: string,
    version: number,
    prefer?: Team,
    payloadHostToken?: string,
    sessionToken?: string,
  ): void {
    if (version !== PROTOCOL_VERSION) {
      this.send(ws, { t: 'error', code: 'version_mismatch', message: 'update your client' });
      ws.close(4001, 'version');
      return;
    }
    // Resumption path: if the client presents a sessionToken matching a
    // PlayerState still in the players map (because their WS dropped less
    // than RECONNECT_GRACE_MS ago and we held the slot open), rebind the
    // new WS to that existing player and replay the snapshot. No new
    // PlayerState is created; team, position, frozen, sprintEnergy all
    // carry over so the player resumes mid-match rather than starting
    // fresh in `filling`. This is what closes the "round resets back to
    // disperse after a transient WS drop" bug.
    // Track whether the client presented a sessionToken so the failure
    // path below can distinguish "your resume slot is gone" (token was
    // presented but invalid - grace expired) from "you joined a running
    // match fresh" (no token, never had a slot in this room). The client
    // surfaces these as different popups since the user-actionable next
    // step is different (one returns to menu, the other suggests a new
    // Find Match).
    const presentedToken = typeof sessionToken === 'string' && sessionToken !== '';
    if (presentedToken) {
      const existingId = this.resumePlayerId(sessionToken!);
      if (existingId !== null) {
        this.resumeSession(ws, existingId);
        return;
      }
    }
    if (this.phase !== 'filling') {
      // Match already running and the client did not present a valid
      // sessionToken. This is the freeze-circumvention guard: a player
      // who left mid-match can't come back as a fresh PlayerState. They
      // can only resume the slot they already held (via sessionToken)
      // for the grace window.
      const code = presentedToken ? 'session_expired' : 'match_in_progress';
      const message = presentedToken
        ? 'your reconnect window expired'
        : 'this match has already started';
      // session_expired closes with 4004; match_in_progress stays on
      // 4003 for backwards compatibility with older client builds that
      // only know that code.
      this.send(ws, { t: 'error', code, message });
      ws.close(presentedToken ? 4004 : 4003, code);
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
      this.bots.kickOneFromTeam(team);
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
      jumpStartedAt: null,
    };
    this.players.set(id, player);
    this.connections.set(ws, { ws, playerId: id });
    // Mint the resumption secret now so the snapshot below can carry it
    // back to the client. Kept server-side in SessionManager; never sent
    // to other clients.
    const newSessionToken = this.sessions.mint(id);
    // Host detection: the matchmaker stamped the room's expectedHostToken
    // on the host's WS URL. Compare both the per-WS token (from the URL
    // we saw on upgrade) and the optional payload token (belt and braces
    // for clients that prefer to keep the token out of the URL). The
    // first player whose token matches becomes the host; subsequent
    // matches are ignored.
    if (this.expectedHostToken !== null && this.hostPlayerId === null) {
      const urlToken = this.hostTokenByWs.get(ws);
      if (
        (urlToken && urlToken === this.expectedHostToken) ||
        (payloadHostToken && payloadHostToken === this.expectedHostToken)
      ) {
        this.hostPlayerId = id;
      }
    }
    this.send(ws, {
      t: 'snapshot',
      snapshot: this.snapshot(),
      youAre: id,
      sessionToken: newSessionToken,
    });
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    // Auto-start fallback only applies when the room has NO host. Private
    // lobbies (matchmaker minted a hostToken) wait for an explicit
    // start_match from the host; open/strangers rooms keep starting on
    // the 2nd human / bot-fill timer like before.
    const hasHost = this.expectedHostToken !== null;
    if (!hasHost) {
      if (this.phase === 'filling' && this.humanPlayers().length >= 2 && !this.tickHandle) {
        this.startMatch();
      } else if (this.phase === 'filling' && !this.tickHandle) {
        this.bots.scheduleFill();
      }
    }
    this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
    this.persist();
  }

  private onStartMatch(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn || conn.playerId !== this.hostPlayerId) {
      this.send(ws, { t: 'error', code: 'not_host', message: 'only the host can start' });
      return;
    }
    if (this.phase !== 'filling') {
      this.send(ws, {
        t: 'error',
        code: 'match_in_progress',
        message: 'match has already started',
      });
      return;
    }
    // Cancel the auto-fill timer if one happened to be scheduled (it would
    // not normally fire for a hosted room, but the matchmaker may have
    // changed mid-room or the room may have been promoted; safer to be
    // defensive). Then fill bots and transition into free roam.
    this.bots.cancelFill();
    this.bots.fillTeams();
    this.startMatch();
  }

  /** Schedule a one-shot bot fill so a solo joiner gets opponents within a few seconds. */

  /**
   * Returns true if landing at (x, z) would put this player inside another
   * player's personal space. Without this check, two bodies in the same
   * corridor push through each other every tick and the client renders the
   * back-and-forth as visible jitter. The threshold is two body radii plus
   * a small buffer so capsules never touch.
   */
  /**
   * Pick a spawn point that (a) is not inside a wall, and (b) does not
   * overlap any existing player. Tries up to SPAWN_PICK_ATTEMPTS jitter
   * samples around the team center, then falls back to a hex-spiral search
   * outward if every jitter sample is blocked. The final fallback (the
   * team center itself) is only returned when the team area is so cramped
   * that no spawn can satisfy both constraints, and downstream collision
   * resolution will nudge the player out of any remaining overlap on the
   * next tick.
   */
  private pickSpawnPosition(team: Team): Vec3 {
    const minPlayerSep = 2 * PLAYER_RADIUS + 0.2;
    const minPlayerSepSq = minPlayerSep * minPlayerSep;
    const center = teamSpawnCenter(team);
    const at = (x: number, z: number): Vec3 => ({ x, y: HOVER_HEIGHT, z });
    const isValid = (x: number, z: number): boolean => {
      if (this.walls.length > 0 && pointBlockedByWall(this.walls, x, z)) return false;
      for (const other of this.players.values()) {
        const dx = other.position.x - x;
        const dz = other.position.z - z;
        if (dx * dx + dz * dz < minPlayerSepSq) return false;
      }
      return true;
    };
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const candidate = jitteredSpawn(team);
      if (isValid(candidate.x, candidate.z)) return at(candidate.x, candidate.z);
    }
    // Deterministic outward sweep: rings of 6, 12, 18 candidates at
    // increasing radius around the team center. Catches the case where
    // the team's open cell is densely packed and the random jitter keeps
    // landing on overlap.
    for (let ring = 1; ring <= 6; ring += 1) {
      const radius = ring * (2 * PLAYER_RADIUS + 0.1);
      const count = 6 * ring;
      for (let k = 0; k < count; k += 1) {
        const angle = (k / count) * Math.PI * 2;
        const x = center.x + Math.cos(angle) * radius;
        const z = center.z + Math.sin(angle) * radius;
        if (isValid(x, z)) return at(x, z);
      }
    }
    return at(center.x, center.z);
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
    this.hostTokenByWs.delete(ws);
    this.rateLimiters.delete(ws);
    // If the host drops, leave hostPlayerId null. They (or a successor
    // who knows the hostToken) will re-claim on the next join. The room
    // stays in `filling` until something triggers startMatch, so the
    // empty-host state never strands the lobby.
    if (this.hostPlayerId === conn.playerId) {
      this.hostPlayerId = null;
    }
    // Hold the slot open for RECONNECT_GRACE_MS so a transient drop can
    // resume via sessionToken instead of tearing the match down. The
    // PlayerState stays in `players`, the tick keeps running, and bots
    // keep playing against the (now-stationary) body. If no reconnect
    // arrives in time, finalizeDisconnect runs the real teardown.
    //
    // Skip the grace window while the room is still in `filling` - there
    // is no match to preserve, the player was just sitting in the lobby
    // and the host-token / roster bookkeeping should not linger.
    if (this.phase === 'filling') {
      this.finalizeDisconnect(conn.playerId);
      return;
    }
    // Drop any queued inputs so the still-present body does not keep
    // moving by replaying stale inputs while the player is gone.
    this.inputQueues.delete(conn.playerId);
    const finalizeId = conn.playerId;
    this.sessions.scheduleFinalize(finalizeId, () => this.finalizeDisconnect(finalizeId));
    this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
    this.persist();
  }

  private finalizeDisconnect(playerId: string): void {
    this.players.delete(playerId);
    this.sessions.forget(playerId);
    this.inputQueues.delete(playerId);
    this.lastAppliedSeq.delete(playerId);
    this.lastSavedAt.delete(playerId);
    this.positionHistory.delete(playerId);
    if (this.humanPlayers().length === 0) {
      this.stopTick();
      this.bots.cancelFill();
      this.bots.clear();
      this.phase = 'filling';
      this.detachMatchmaker();
      // Room is empty - drop the persisted snapshot so the next client
      // who lands on this DO gets a clean room rather than a stale
      // snapshot. The DO instance can also be evicted by CF at this
      // point without leaving disk garbage behind.
      this.persistence.clear();
    } else {
      this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
      this.persist();
    }
  }

  private resumePlayerId(sessionToken: string): string | null {
    const id = this.sessions.resumePlayerId(sessionToken);
    // Verify the player slot is still alive: a session token can outlive
    // its player if finalizeDisconnect ran in the gap between detach and
    // the client's resume attempt.
    return id !== null && this.players.has(id) ? id : null;
  }

  private resumeSession(ws: WebSocket, playerId: string): void {
    this.sessions.cancelFinalize(playerId);
    // Replace any stale connection record bound to this playerId. The
    // old WS object is dead at this point (close fired), but the entry
    // would otherwise sit in this.connections forever.
    for (const [oldWs, conn] of this.connections) {
      if (conn.playerId === playerId) this.connections.delete(oldWs);
    }
    this.connections.set(ws, { ws, playerId });
    // Re-evaluate host status for the resumed connection. A new WS upgrade
    // may have stamped a fresh host token on the URL even if the player's
    // first connection didn't.
    if (this.hostPlayerId === playerId || this.hostPlayerId === null) {
      const urlToken = this.hostTokenByWs.get(ws);
      if (urlToken && this.expectedHostToken !== null && urlToken === this.expectedHostToken) {
        this.hostPlayerId = playerId;
      }
    }
    this.send(ws, {
      t: 'snapshot',
      snapshot: this.snapshot(),
      youAre: playerId,
      sessionToken: this.sessions.tokenFor(playerId),
    });
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
    this.persist();
  }

  private onInput(ws: WebSocket, input: PlayerInput): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    let q = this.inputQueues.get(conn.playerId);
    if (!q) {
      q = [];
      this.inputQueues.set(conn.playerId, q);
    }
    q.push(input);
    // Overflow drops the OLDEST. Keeping recent inputs matters more than
    // keeping every input: a stale move from 80 ms ago that the client
    // already corrected away from is worse than letting the simulation
    // skip it. Same trade-off Overwatch describes for its command buffer.
    while (q.length > MAX_INPUT_QUEUE) q.shift();
  }

  private onTag(ws: WebSocket, targetId: string): void {
    this.tagManager.onTag(ws, targetId, TAG_RADIUS_CLIENT);
  }

  private onUnfreeze(ws: WebSocket, targetId: string): void {
    this.tagManager.onUnfreeze(ws, targetId);
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
  private humanPlayers(): PlayerState[] {
    return [...this.players.values()].filter((p) => !p.bot);
  }

  // Humans whose WS is currently connected. Excludes players whose
  // disconnectTimers entry is pending (the session-token grace window).
  // Used by tick() to pause the world while every human is in grace,
  // so a solo player who briefly drops wifi does not return to a
  // partially-collapsed match.
  private activeHumans(): number {
    return this.humanPlayers().length - this.sessions.pendingDisconnectCount();
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

  private startMatch(): void {
    this.balanceHumansForMatchStart();
    this.firstTeam = Math.random() < 0.5 ? 'mime' : 'clown';
    this.phase = 'free_roam';
    this.turnEndsAt = Date.now() + FREE_ROAM_MS;
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    this.tickHandle = setInterval(() => this.sim.tick(), TICK_MS);
    // Drop ourselves from the matchmaker's open-room pool immediately
    // so strangers stop being routed here. The notifyMatchmaker guard
    // would catch a subsequent call too, but doing it now closes the
    // window between `phase = free_roam` and the next state push.
    this.detachMatchmaker();
    // Persist after fillBots (run inside scheduleFill or via balanceHumans
    // here) and the phase flip so a deploy mid-game restores the match
    // with bots + first-team + turnEndsAt all set.
    this.persist();
  }

  /**
   * Even out the human roster across the two teams immediately before the
   * match goes live. Until this point every human was assigned a team at
   * `onJoin` via `pickTeam`, which biases toward the under-tallied side as
   * each player arrives. That works while everyone joins in clean
   * alternation, but the playtest reported all five humans landing on
   * `mime` - the join order, bot pre-fills, and tie-break (`mime` wins on
   * equal tallies) lined up to give one team every human in the room.
   * Sorting by id (UUIDs are random) and alternating assignments here
   * guarantees a 50/50 split regardless of join order.
   *
   * Runs before `fillBots` would notice any imbalance, since `startMatch`
   * is the single funnel and the bot fill happens at the callers (one
   * step earlier in `onStartMatch` / `scheduleBotFill`). Re-spawning a
   * human whose team changed is necessary so they don't start in the
   * other team's territory.
   */
  private balanceHumansForMatchStart(): void {
    const reassignments = balanceTeamAssignments([...this.players.values()]);
    for (const [id, team] of reassignments) {
      const p = this.players.get(id);
      if (p) {
        p.team = team;
        p.position = this.pickSpawnPosition(team);
      }
    }
  }

  private activeTurnTeam(): Team | null {
    if (this.phase === 'turn_mime') return 'mime';
    if (this.phase === 'turn_clown') return 'clown';
    return null;
  }

  private snapshot(): RoomSnapshot {
    return this.broadcaster.snapshot();
  }

  private broadcast(msg: ServerToClient): void {
    this.broadcaster.broadcast(msg);
  }

  private send(ws: WebSocket, msg: ServerToClient): void {
    this.broadcaster.send(ws, msg);
  }

  private stopTick(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }
}

function isValidTopology(value: string): value is Topology {
  return value === 'plane' || value === 'torus' || value === 'mobius' || value === 'klein';
}

// Team spawn centers sit in the interior of a grid-maze cell so the jitter
// stays clear of wall seams. Cell centers in a 10x10 grid (cell size 8) are at
// every (+-4 + k*8) coord; mimes get (-12, 4) and clowns (12, 4) - two cells
// apart in the x direction, both well off the origin grid line.
function teamSpawnCenter(team: Team): { x: number; z: number } {
  return team === 'mime' ? { x: -12, z: 4 } : { x: 12, z: 4 };
}

function jitteredSpawn(team: Team): { x: number; z: number } {
  const center = teamSpawnCenter(team);
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
