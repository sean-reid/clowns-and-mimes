import type {
  ClientToServer,
  PlayerInput,
  PlayerState,
  RoomPhase,
  RoomSnapshot,
  ServerToClient,
  Team,
  Topology,
  Vec2,
} from '@cm/shared';
import { BATTLE_CRY_COUNT, PROTOCOL_VERSION } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedUnitDelta } from '@cm/shared/topology';
import {
  generateWalls,
  pathCrossesWall,
  pointBlockedByWall,
  PLAYER_RADIUS,
  type WallSegment,
} from '@cm/shared/labyrinth';
import { balanceTeamAssignments } from './teamBalance.ts';
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
// Per-player input-queue cap. The client streams inputs at TICK_HZ so the
// steady-state queue size is 0 or 1. Allow a few ticks of headroom so a
// network jitter burst is absorbed instead of dropping inputs at the door;
// past this limit the OLDEST is dropped so the simulation does not lag
// further behind live time.
const MAX_INPUT_QUEUE = 4;
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
// Window during which a player whose WS has closed can reconnect with
// their sessionToken and resume the same PlayerState. Bots keep playing
// against them in absentia; their input queue stays empty so their body
// stands still (and is vulnerable to tags) until the WS is back. After
// the window expires their PlayerState is torn down for real and the
// usual humans-zero match-state cleanup runs.
const RECONNECT_GRACE_MS = 15_000;
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
// Bot "no-progress" detector. simulateBots reports moved=true whenever any
// axis-slide candidate succeeds, but a bot grinding x-only against a
// horizontal wall will pass the check every tick while making no headway
// toward its target. If the world-space distance covered in
// BOT_NO_PROGRESS_WINDOW_MS stays below BOT_NO_PROGRESS_MIN_DIST, force a
// retarget: pick a new patrol point, drop the engaged enemy target so the
// chase BFS re-runs, and zero the direction-smoothing carry-over so the
// new heading takes effect immediately.
const BOT_NO_PROGRESS_WINDOW_MS = 800;
const BOT_NO_PROGRESS_MIN_DIST = 0.5;
// World units to project ahead of the bot when fleeing. The unit-delta
// "away" vector is fed into the BFS pathfinder against this projected
// target so the route bends around walls instead of crashing straight back
// into a corner. 12 units is enough to cross one or two grid cells in any
// topology.
const BOT_FLEE_PROJECTION = 12;
// "Last-known position" investigation window. When a target the bot had
// engaged with becomes occluded behind a wall, the bot doesn't drop them
// instantly - it routes toward the last position it could see them and
// holds the chase for BOT_INVESTIGATE_MS. If the target reappears in that
// window the chase resumes; if not, engagedTargetId clears and the bot
// returns to patrol. Same pattern Half-Life HECU grunts and Halo grunts
// use to keep "lost the player around a corner" play readable rather
// than instantly omniscient.
const BOT_INVESTIGATE_MS = 3_000;
// Each bot remembers the last BOT_RECENT_TARGETS_KEEP patrol points it
// committed to. A new patrol candidate within BOT_RECENT_TARGET_RADIUS of
// any of them is rejected, so the bot doesn't pace back and forth between
// the same two or three spots. After BOT_PATROL_CANDIDATE_ATTEMPTS tries
// we accept whatever the next random draw gives - on a dense maze with
// many bots the entire reachable space may be in the memory window.
const BOT_RECENT_TARGETS_KEEP = 6;
const BOT_RECENT_TARGET_RADIUS = 10;
const BOT_PATROL_CANDIDATE_ATTEMPTS = 8;

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
  // Progress tracking for "is this bot pinned against geometry?" detection.
  // The slide-fallback in simulateBots happily reports moved=true when only
  // an x-only or z-only candidate succeeded, even when the bot is grinding
  // straight into a wall every tick. Sample position every
  // BOT_NO_PROGRESS_WINDOW_MS and force a retarget if the distance covered
  // in that window stays below BOT_NO_PROGRESS_MIN_DIST.
  progressSampleAt: number;
  progressSamplePos: { x: number; z: number };
  // Last position the bot could actually see the engaged target at, and the
  // deadline by which the bot must reacquire line-of-sight before giving up.
  // Set when nearestVisibleEnemy returns null but the previously-engaged
  // target still exists (occluded). While investigating, the bot routes to
  // lastKnownPos via BFS as if it were a patrol point. Both null when not
  // actively investigating.
  lastKnownPos: { x: number; z: number } | null;
  investigateUntil: number;
  // Recent patrol targets the bot has committed to. randomPatrolPoint
  // rejects candidates near any of these so a wandering bot explores
  // different parts of the map instead of pacing between the same spots.
  // Newest at the end; capped at BOT_RECENT_TARGETS_KEEP.
  recentTargets: Array<{ x: number; z: number }>;
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
      } else if (this.phase === 'filling' && this.botFillHandle === null && !this.tickHandle) {
        this.scheduleBotFill();
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
    if (this.botFillHandle !== null) {
      clearTimeout(this.botFillHandle);
      this.botFillHandle = null;
    }
    this.fillBots();
    this.startMatch();
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
        const spawn = this.pickSpawnPosition(team);
        this.players.set(id, {
          id,
          name: generateBotName(),
          team,
          bot: true,
          position: spawn,
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
          progressSampleAt: Date.now(),
          progressSamplePos: { x: spawn.x, z: spawn.z },
          lastKnownPos: null,
          investigateUntil: 0,
          recentTargets: [],
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

  // Pick a patrol point that (a) is not inside a wall's clearance band and
  // (b) is at least BOT_RECENT_TARGET_RADIUS from every point on the bot's
  // recent-targets ring. Rejecting wall-clipped candidates keeps the bot
  // exploring open corridors instead of pathfinding toward a coordinate
  // inside a wall; rejecting near-recent candidates stops the pacing /
  // backtracking pattern that pure random sampling produces. After
  // BOT_PATROL_CANDIDATE_ATTEMPTS rejections we accept whatever the next
  // draw returns - a maze packed full of bots may eventually fill the
  // memory window with the entire reachable space.
  private pickExplorationPatrolPoint(recentTargets: ReadonlyArray<{ x: number; z: number }>): {
    x: number;
    z: number;
  } {
    let last = this.randomPatrolPoint();
    for (let attempt = 0; attempt < BOT_PATROL_CANDIDATE_ATTEMPTS; attempt += 1) {
      const candidate = this.randomPatrolPoint();
      last = candidate;
      if (this.walls.length > 0 && pointBlockedByWall(this.walls, candidate.x, candidate.z)) {
        continue;
      }
      let tooClose = false;
      for (const recent of recentTargets) {
        const dx = candidate.x - recent.x;
        const dz = candidate.z - recent.z;
        if (dx * dx + dz * dz < BOT_RECENT_TARGET_RADIUS * BOT_RECENT_TARGET_RADIUS) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      return candidate;
    }
    return last;
  }

  // Commit a fresh patrol point to the bot's mind, updating the
  // recent-targets ring buffer so future picks can avoid the area.
  private commitPatrolTarget(mind: BotMind): void {
    mind.patrolTarget = this.pickExplorationPatrolPoint(mind.recentTargets);
    mind.recentTargets.push({ x: mind.patrolTarget.x, z: mind.patrolTarget.z });
    while (mind.recentTargets.length > BOT_RECENT_TARGETS_KEEP) {
      mind.recentTargets.shift();
    }
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
   * Pick a spawn point that (a) is not inside a wall, and (b) does not
   * overlap any existing player. Tries up to SPAWN_PICK_ATTEMPTS jitter
   * samples around the team center, then falls back to a hex-spiral search
   * outward if every jitter sample is blocked. The final fallback (the
   * team center itself) is only returned when the team area is so cramped
   * that no spawn can satisfy both constraints, and downstream collision
   * resolution will nudge the player out of any remaining overlap on the
   * next tick.
   */
  private pickSpawnPosition(team: Team): { x: number; z: number } {
    const minPlayerSep = 2 * PLAYER_RADIUS + 0.2;
    const minPlayerSepSq = minPlayerSep * minPlayerSep;
    const center = teamSpawnCenter(team);
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
      if (isValid(candidate.x, candidate.z)) return candidate;
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
        if (isValid(x, z)) return { x, z };
      }
    }
    return center;
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
      this.cancelBotFill();
      this.clearBots();
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
    // Direction smoothing: 0.5 of the previous heading carries forward each
    // tick. A new heading is fully reached in ~3 ticks (50 ms at 60 Hz),
    // which reads as alert rather than the previous ~10-tick laggy turn.
    // Genuine indecision (e.g., two equidistant targets) is still caught by
    // the no-progress detector forcing a retarget within 800 ms.
    const DIR_SMOOTHING = 0.5;
    // Cap on body rotation per second. 9 rad/s clears a 90 deg turn in
    // ~175 ms - agile enough to read as reactive without being twitchy.
    // Slide-fallback axis flips are still smoothed by DIR_SMOOTHING above
    // so the body never snaps a full quarter-turn in a single tick.
    const MAX_YAW_RATE = 9.0;
    const RETARGET_HYSTERESIS = 0.75; // new target must be this fraction of current distance to swap
    for (const bot of this.botPlayers()) {
      if (bot.frozen) continue;
      const mind = this.botMinds.get(bot.id) ?? {
        patrolTarget: this.randomPatrolPoint(),
        patrolUntil: 0,
        engagedTargetId: null,
        lastDir: { x: 0, z: 0 },
        lastYaw: bot.yaw,
        progressSampleAt: now,
        progressSamplePos: { x: bot.position.x, z: bot.position.z },
        lastKnownPos: null,
        investigateUntil: 0,
        recentTargets: [],
      };
      this.botMinds.set(bot.id, mind);

      // Sticky target with line-of-sight gating. nearestVisibleEnemy already
      // filters by pathCrossesWall, so candidate is null when no enemy is
      // both within range AND has clear sight. Keep the previously-engaged
      // target only if they are still visible. When LOS to the engaged
      // target is lost, hold onto engagedTargetId and stamp lastKnownPos /
      // investigateUntil so the bot routes toward where the target was last
      // seen for BOT_INVESTIGATE_MS before giving up.
      const candidate = this.nearestVisibleEnemy(bot);
      const candidateDist = candidate
        ? topologyDistance(bot.position, candidate.position, this.topology, WORLD_WIDTH)
        : Infinity;
      let target: PlayerState | null = candidate;
      let enemyDist = candidateDist;
      if (mind.engagedTargetId) {
        const existing = this.players.get(mind.engagedTargetId);
        if (existing && !existing.frozen && existing.team !== bot.team) {
          const existingVisible = this.botCanSee(bot.position, existing.position);
          const existingDist = topologyDistance(
            bot.position,
            existing.position,
            this.topology,
            WORLD_WIDTH,
          );
          if (
            existingVisible &&
            existingDist < BOT_VISION_RADIUS &&
            candidateDist >= existingDist * RETARGET_HYSTERESIS
          ) {
            target = existing;
            enemyDist = existingDist;
          } else if (!existingVisible && existingDist < BOT_VISION_RADIUS) {
            // Target ducked behind cover. Investigate the last-seen
            // position only when the bot is the active hunter; if our turn
            // is the defender we'd just be walking back into the threat,
            // so clear and let the flee branch (which gates on target
            // visibility) decide what to do once they reappear.
            if (active === bot.team) {
              if (!mind.lastKnownPos) {
                mind.lastKnownPos = { x: existing.position.x, z: existing.position.z };
                mind.investigateUntil = now + BOT_INVESTIGATE_MS;
              }
            } else {
              mind.engagedTargetId = null;
              mind.lastKnownPos = null;
              mind.investigateUntil = 0;
            }
          }
        } else {
          // Engaged target left the room or joined our team; abandon them.
          mind.engagedTargetId = null;
          mind.lastKnownPos = null;
          mind.investigateUntil = 0;
        }
      }
      if (target) {
        // Fresh sighting (or re-sighting) clears any in-flight investigation.
        mind.engagedTargetId = target.id;
        mind.lastKnownPos = { x: target.position.x, z: target.position.z };
        mind.investigateUntil = 0;
      } else if (mind.investigateUntil > 0 && now >= mind.investigateUntil) {
        // Investigation window expired without re-acquiring sight. Drop the
        // engaged target and fall back to patrol.
        mind.engagedTargetId = null;
        mind.lastKnownPos = null;
        mind.investigateUntil = 0;
      }
      const investigating =
        target === null && mind.lastKnownPos !== null && now < mind.investigateUntil;

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
        // a teammate is frozen nearby. Route the flee through the BFS
        // pathfinder: project a synthetic flee target BOT_FLEE_PROJECTION
        // units along the unit-away vector and ask the pathfinder for the
        // next waypoint to it. Without this the raw away-vector bee-lines
        // the bot into the closest corner because no wall lookahead is in
        // the loop. The avoid set keeps the bot off frozen-teammate cells
        // for the same reason chase does.
        const away = wrappedUnitDelta(target.position, bot.position, this.topology, WORLD_WIDTH);
        const fleeTarget = wrapPosition(
          {
            x: bot.position.x + away.x * BOT_FLEE_PROJECTION,
            z: bot.position.z + away.z * BOT_FLEE_PROJECTION,
          },
          this.topology,
          WORLD_WIDTH,
        );
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = this.pathfinder
          ? this.pathfinder.nextWaypointAvoiding(bot.position, fleeTarget, avoid)
          : fleeTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, this.topology, WORLD_WIDTH);
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
      } else if (investigating && mind.lastKnownPos) {
        // Target ducked behind cover within the last BOT_INVESTIGATE_MS.
        // Route to where they were last seen via BFS. If they reappear at
        // any point during the window, the target acquisition block above
        // will pick them up again and the investigation flag clears on the
        // next tick. If we reach lastKnownPos without re-acquiring sight,
        // hold position there until investigateUntil expires.
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = this.pathfinder
          ? this.pathfinder.nextWaypointAvoiding(bot.position, mind.lastKnownPos, avoid)
          : mind.lastKnownPos;
        dir = wrappedUnitDelta(bot.position, waypoint, this.topology, WORLD_WIDTH);
      } else {
        if (now >= mind.patrolUntil || nearTarget(bot.position, mind.patrolTarget)) {
          this.commitPatrolTarget(mind);
          mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
        }
        // Route patrol through the BFS pathfinder the same way chase /
        // rescue / flee / investigate do. Without this, a patrol target on
        // the far side of a wall has the bot bee-lining straight at the
        // geometry, relying on the per-tick axis-slide + no-progress
        // retarget to bounce off. With BFS routing the bot follows
        // corridors and reads as deliberately exploring rather than
        // ricocheting off walls.
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = this.pathfinder
          ? this.pathfinder.nextWaypointAvoiding(bot.position, mind.patrolTarget, avoid)
          : mind.patrolTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, this.topology, WORLD_WIDTH);
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
          bot.position = this.pickSpawnPosition(bot.team);
        }
        this.commitPatrolTarget(mind);
        mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
      }

      // No-progress detector. moved=true is satisfied as long as ANY axis
      // candidate succeeds, so a bot grinding x-only into a horizontal wall
      // passes the check every tick while making no headway. Sample the
      // bot's position every BOT_NO_PROGRESS_WINDOW_MS and force a retarget
      // when the distance covered in that window stays below
      // BOT_NO_PROGRESS_MIN_DIST: pick a fresh patrol point, drop the
      // engaged enemy so the chase BFS re-runs, and zero the smoothing
      // carry-over so the new heading takes effect on the next tick.
      if (now - mind.progressSampleAt >= BOT_NO_PROGRESS_WINDOW_MS) {
        const covered = topologyDistance(
          mind.progressSamplePos,
          bot.position,
          this.topology,
          WORLD_WIDTH,
        );
        if (covered < BOT_NO_PROGRESS_MIN_DIST) {
          this.commitPatrolTarget(mind);
          mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
          mind.engagedTargetId = null;
          mind.lastDir = { x: 0, z: 0 };
        }
        mind.progressSampleAt = now;
        mind.progressSamplePos = { x: bot.position.x, z: bot.position.z };
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
      if (!this.botCanSee(bot.position, other.position)) continue;
      const d = topologyDistance(bot.position, other.position, this.topology, WORLD_WIDTH);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
  }

  // Line-of-sight test between two world-space points. A wall in the way
  // means the bot cannot see the target, which gates the entry into chase
  // (and flee) and triggers the last-known-position investigation when an
  // engaged target ducks behind cover. Uses the same pathCrossesWall the
  // movement system uses so "can the bot see them" and "could the bot move
  // there" stay in lockstep.
  private botCanSee(from: Vec2, to: Vec2): boolean {
    if (this.walls.length === 0) return true;
    return !pathCrossesWall(this.walls, from.x, from.z, to.x, to.z);
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
  return value === 'plane' || value === 'torus' || value === 'mobius' || value === 'klein';
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
