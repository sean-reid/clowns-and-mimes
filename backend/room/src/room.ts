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
import { BATTLE_CRY_COUNT, PROTOCOL_VERSION } from '@cm/shared';
import { HOVER_HEIGHT, JUMP_COOLDOWN_S, JUMP_DURATION_S } from '@cm/shared/physics';
import {
  generateWalls,
  pointBlockedByWall,
  PLAYER_RADIUS,
  type WallSegment,
} from '@cm/shared/labyrinth';
import { balanceTeamAssignments } from './teamBalance.ts';
import {
  bodyYForState,
  resolvePlayerCollisions,
  stepJump,
  stepMovement,
  MAX_SPRINT,
} from '@cm/shared/movement';
import { BotManager, type BotManagerHost } from './botManager.ts';
import { BotPathfinder } from './botPathfinder.ts';
import { parseClientMessage } from './messageValidator.ts';
import { RateLimiter } from './rateLimiter.ts';
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
// Movement constants and stepMovement are imported from @cm/shared/movement
// so the client predictor can call identical math during reconciliation.
const TURN_FIRST_MS = 30_000;
const TURN_STEP_MS = 30_000;
const TURN_CAP_MS = 5 * 60_000;
// Maximum drift allowed between the client's stamped input.nowMs and
// the server's Date.now() when the input lands. Inputs whose nowMs is
// further out are still honoured but the server re-stamps the jump
// arc start with its own clock, so a misbehaving (or wildly out of
// sync) client cannot anchor jumpStartedAt arbitrarily far in the past
// or future. 500 ms is generous against legitimate network jitter and
// tight enough that the cheat ceiling is bounded.
const JUMP_CLIENT_CLOCK_SKEW_MS = 500;
// Window during which a player whose WS has closed can reconnect with
// their sessionToken and resume the same PlayerState. Bots keep playing
// against them in absentia; their input queue stays empty so their body
// stands still (and is vulnerable to tags) until the WS is back. After
// the window expires their PlayerState is torn down for real and the
// usual humans-zero match-state cleanup runs.
//
// 45 s is sized to outrun the worst-case client reconnect ladder. The
// arena schedules 3 attempts with backoffs [0.5, 1.5, 3.0] and each
// step waits `wait_s + 1` for the connection result, so the ladder
// itself can take ~13 s. The disconnect also takes a moment to surface
// on the client (TCP retries, Godot's STATE_CLOSED detection). 15 s
// left only ~2 s of margin and lost the race in the wild: finalize
// ran first, the player slot was nuked, and the reconnect arrived as
// a fresh join in a bot-empty room.
const RECONNECT_GRACE_MS = 45_000;
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
  // Per-player resumption secrets. Handed to the client in their snapshot
  // and presented back on the next `join` so a transient WS drop is
  // resumed against the same PlayerState (team, position, frozen) rather
  // than treated as a fresh join. Map is human-only; bots never reconnect.
  private readonly sessionTokens = new Map<string, string>();
  // Player ids whose WS has dropped but who are still inside the
  // RECONNECT_GRACE_MS window. Their PlayerState stays in `players` so
  // the match can keep ticking; if they reconnect with the right
  // sessionToken we rebind their WS and resume. After the window expires
  // we run the real teardown via finalizeDisconnect.
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  // Date.now() at the moment the world paused because every human went
  // into the disconnect grace window. Null while at least one human is
  // active. On resume the first non-paused tick shifts turnEndsAt
  // forward by the elapsed pause so the phase clock effectively pauses
  // alongside the simulation (otherwise a 10 s wifi drop would burn
  // through 10 s of the active turn timer in the player's absence).
  private pausedSince: number | null = null;
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
  // One token bucket per live WebSocket. Created on accept, removed on
  // detach. webSocketMessage rejects with a rate_limited error when the
  // bucket is empty; the connection stays open so a transient burst
  // doesn't force a reconnect cycle.
  private readonly rateLimiters = new Map<WebSocket, RateLimiter>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RoomEnv = {},
  ) {
    this.walls = generateWalls(this.seed, this.topology);
    this.rebuildPathfinder();
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
      },
      positionAt: (id, atMs) => this.positionAt(id, atMs),
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
    if (sessionToken) {
      const existingId = this.resumePlayerId(sessionToken);
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
      this.send(ws, {
        t: 'error',
        code: 'match_in_progress',
        message: 'this match has already started',
      });
      ws.close(4003, 'match_in_progress');
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
    // back to the client. Kept server-side in sessionTokens; never sent
    // to other clients.
    const newSessionToken = crypto.randomUUID();
    this.sessionTokens.set(id, newSessionToken);
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
    const existing = this.disconnectTimers.get(conn.playerId);
    if (existing !== undefined) clearTimeout(existing);
    this.disconnectTimers.set(
      conn.playerId,
      setTimeout(() => {
        this.disconnectTimers.delete(conn.playerId);
        this.finalizeDisconnect(conn.playerId);
      }, RECONNECT_GRACE_MS),
    );
    this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
  }

  private finalizeDisconnect(playerId: string): void {
    this.players.delete(playerId);
    this.sessionTokens.delete(playerId);
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
    } else {
      this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
    }
  }

  private resumePlayerId(sessionToken: string): string | null {
    for (const [id, token] of this.sessionTokens) {
      if (token === sessionToken && this.players.has(id)) return id;
    }
    return null;
  }

  private resumeSession(ws: WebSocket, playerId: string): void {
    const pending = this.disconnectTimers.get(playerId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.disconnectTimers.delete(playerId);
    }
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
    const token = this.sessionTokens.get(playerId) ?? '';
    this.send(ws, {
      t: 'snapshot',
      snapshot: this.snapshot(),
      youAre: playerId,
      sessionToken: token,
    });
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    this.notifyMatchmaker(this.humanPlayers().length, this.botPlayers().length);
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
    return this.humanPlayers().length - this.disconnectTimers.size;
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
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
    // Drop ourselves from the matchmaker's open-room pool immediately
    // so strangers stop being routed here. The notifyMatchmaker guard
    // would catch a subsequent call too, but doing it now closes the
    // window between `phase = free_roam` and the next state push.
    this.detachMatchmaker();
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

  private tick(): void {
    // Pause the world while every human is in the session-token grace
    // window. Without this, a solo player who briefly drops wifi has
    // the bots keep attacking their stationary body, the match runs
    // through turn transitions in their absence, and frequently
    // checkWin terminates the round before they can reconnect. The
    // server tick keeps firing (the setInterval handle is still alive)
    // but turning the body of the work into a no-op preserves player
    // positions while the turnEndsAt cursor gets shifted forward on
    // resume. Multi-human matches stay unaffected: as long as one
    // human is connected, activeHumans > 0 and the tick runs normally.
    if (this.activeHumans() === 0) {
      if (this.pausedSince === null) this.pausedSince = Date.now();
      return;
    }
    if (this.pausedSince !== null) {
      // First tick after a resume - shift the turn clock forward by the
      // pause duration so a returning player does not find their turn
      // already half-over.
      this.turnEndsAt += Date.now() - this.pausedSince;
      this.pausedSince = null;
    }
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
    this.bots.simulate(dt);
    this.advanceIdleJumpState();
    // After every player has moved this tick, resolve any overlap +
    // apply bounceback. Runs once per tick so impulses are bounded.
    resolvePlayerCollisions(
      [...this.players.values()],
      this.prevTickPositions,
      dt,
      this.walls,
      this.topology,
      WORLD_WIDTH,
      Date.now(),
    );
    // Refresh prev positions AFTER bounceback so next tick's approach
    // velocity reflects the post-bounce stance, not the pre-bounce
    // overlap that would otherwise show up as a phantom impulse.
    this.prevTickPositions.clear();
    for (const p of this.players.values()) {
      this.prevTickPositions.set(p.id, { x: p.position.x, z: p.position.z });
    }
    this.recordPositionsForLagComp();
  }

  /**
   * Refresh Y and clear stale jumpStartedAt for every player whose
   * stepJump did not run this tick (input queue was empty, or the
   * player is frozen, or is a bot in PR 2 - PR 5 will give bots their
   * own jump trigger). Without this pass, a mid-air player whose
   * inputs stopped landing would have its jumpStartedAt sit at the
   * takeoff timestamp indefinitely and the broadcast snapshot's
   * position.y would stay stale; clients would still compute the
   * correct Y from jumpArcY but the wire would carry the wrong
   * authoritative value.
   */
  private advanceIdleJumpState(): void {
    const now = Date.now();
    const lockoutMs = (JUMP_DURATION_S + JUMP_COOLDOWN_S) * 1000;
    for (const p of this.players.values()) {
      if (p.jumpStartedAt !== null && now - p.jumpStartedAt >= lockoutMs) {
        p.jumpStartedAt = null;
      }
      p.position = {
        x: p.position.x,
        y: bodyYForState({ jumpStartedAt: p.jumpStartedAt }, now),
        z: p.position.z,
      };
    }
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
    for (const [id, q] of this.inputQueues) {
      if (q.length === 0) continue;
      const p = this.players.get(id);
      if (!p || p.bot || p.frozen) {
        // Ineligible player: drain the queue so reconnects or thaws start
        // from a clean slate instead of replaying stale inputs.
        q.length = 0;
        continue;
      }
      // Consume exactly ONE input per tick (oldest first). The client streams
      // at TICK_HZ, so steady state is one in / one out. Network jitter that
      // bunches two inputs into the same socket-read window now lands in the
      // queue and is processed on consecutive ticks rather than overwritten;
      // the client predicted both, the server applies both, and reconciliation
      // never sees the "server is one tick behind" snap that caused the
      // visible step-back stutter while moving.
      const input = q.shift()!;
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
        // No collision gate here: resolvePlayerCollisions in the
        // post-step pass handles overlap by pushing bodies apart and
        // adding the bounceback impulse. A tick-level gate would
        // suppress the overlap that the bounceback design needs to
        // see; per-tick max overlap is bounded by walk speed * dt
        // (~5 cm), which the next tick's resolve fully unwinds.
        () => false,
      );
      // Jump trigger / lockout. The client stamps input.nowMs when it
      // sends the input; we use that timestamp (clamped to local clock
      // skew) as the new jumpStartedAt so the client's predicted arc
      // start matches the authoritative value without a round-trip.
      // Y is computed authoritatively in advanceIdleJumpState at end
      // of tick using the server's Date.now().
      const serverNow = Date.now();
      const inputNow = input.nowMs ?? serverNow;
      const skewMs = Math.abs(inputNow - serverNow);
      const arcNow = skewMs > JUMP_CLIENT_CLOCK_SKEW_MS ? serverNow : inputNow;
      const jump = stepJump(
        { jumpStartedAt: p.jumpStartedAt },
        { jump: input.jump ?? false, nowMs: arcNow },
      );
      p.position = next.position;
      p.jumpStartedAt = jump.jumpStartedAt;
      p.sprintEnergy = next.sprintEnergy;
      p.sprinting = next.sprinting;
      p.yaw = input.lookYaw;
      this.lastAppliedSeq.set(id, input.seq);
    }
  }

  private activeTurnTeam(): Team | null {
    if (this.phase === 'turn_mime') return 'mime';
    if (this.phase === 'turn_clown') return 'clown';
    return null;
  }

  private broadcastDelta(): void {
    this.broadcaster.broadcastDelta();
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
