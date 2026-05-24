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
import { topologyDistance, wrapPosition } from '@cm/shared/topology';
import { generateWalls, pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const FREE_ROAM_MS = 30_000;
const COUNTDOWN_MS = 10_000;
// Server tag radius runs wider than the client's CONTACT_RADIUS so a tag
// fired the moment the client sees contact doesn't fall outside the server's
// check by the time the message arrives. Client interpolation lags one
// snapshot (~50 ms) behind authoritative state, the input round trip adds
// another 50-100 ms. At SPRINT_SPEED (5.6 u/s) the opponent can move up to
// 0.84 units during that combined window; 2.2 leaves 0.8 units of margin
// over CONTACT_RADIUS (1.4) before tag attempts start failing for
// chases. Lag compensation (server rewind on tag_attempt) would be cleaner
// but is a protocol-level rewrite.
const TAG_RADIUS = 2.2;
const UNFREEZE_RADIUS = 2.2;
const WORLD_WIDTH = 80;
const MAX_PLAYERS = 16;
const TEAM_TARGET = 4;
const MAX_SPRINT = 100;
const SPRINT_DRAIN_PER_S = 25;
const SPRINT_REGEN_PER_S = 15;
const WALK_SPEED = 3.2;
const SPRINT_SPEED = 5.6;
const MAX_TICK_TRAVEL = SPRINT_SPEED * 1.5; // anti-cheat: clamp per-tick displacement
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
}

interface Connection {
  ws: WebSocket;
  playerId: string;
}

export class Room implements DurableObject {
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly players = new Map<string, PlayerState>();
  private readonly lastInputs = new Map<string, PlayerInput>();
  private phase: RoomPhase = 'filling';
  private turnEndsAt = 0;
  private topology: Topology = 'plane';
  private seed = Math.floor(Math.random() * 2 ** 31);
  private roundNumber = 0;
  private firstTeam: Team = 'mime';
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private botFillHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly botMinds = new Map<string, BotMind>();
  private walls: readonly WallSegment[] = [];

  constructor(private readonly state: DurableObjectState) {
    this.walls = generateWalls(this.seed, this.topology);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
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
    const player: PlayerState = {
      id,
      name: this.sanitizeName(name),
      team,
      bot: false,
      position: this.pickSpawnPosition(team),
      yaw: 0,
      frozen: false,
      sprintEnergy: MAX_SPRINT,
    };
    this.players.set(id, player);
    this.connections.set(ws, { ws, playerId: id });
    this.send(ws, { t: 'snapshot', snapshot: this.snapshot(), youAre: id });
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    if (this.phase === 'filling' && this.humanPlayers().length >= 2 && !this.tickHandle) {
      this.startCountdown();
    } else if (this.phase === 'filling' && this.botFillHandle === null && !this.tickHandle) {
      this.scheduleBotFill();
    }
  }

  /** Schedule a one-shot bot fill so a solo joiner gets opponents within a few seconds. */
  private scheduleBotFill(): void {
    this.botFillHandle = setTimeout(() => {
      this.botFillHandle = null;
      if (this.phase !== 'filling' || this.tickHandle) return;
      this.fillBots();
      this.startCountdown();
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
        });
        this.botMinds.set(id, {
          patrolTarget: this.randomPatrolPoint(),
          patrolUntil: 0,
          engagedTargetId: null,
          lastDir: { x: 0, z: 0 },
        });
      }
    }
  }

  private randomPatrolPoint(): { x: number; z: number } {
    const half = WORLD_WIDTH / 2;
    return {
      x: (Math.random() - 0.5) * 2 * (half - 4),
      z: (Math.random() - 0.5) * 2 * (half - 4),
    };
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
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.walls = generateWalls(seed, this.topology);
  }

  private detach(ws: WebSocket): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    this.connections.delete(ws);
    this.players.delete(conn.playerId);
    this.lastInputs.delete(conn.playerId);
    if (this.humanPlayers().length === 0) {
      this.stopTick();
      this.cancelBotFill();
      this.clearBots();
      this.phase = 'filling';
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
    if (!this.canTag(attacker, victim)) {
      this.send(ws, { t: 'tag_result', ok: false, reason: 'invalid' });
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
    if (
      topologyDistance(savior.position, victim.position, this.topology, WORLD_WIDTH) >
      UNFREEZE_RADIUS
    ) {
      this.send(ws, { t: 'unfreeze_result', ok: false, reason: 'out_of_range' });
      return;
    }
    victim.frozen = false;
    this.send(ws, { t: 'unfreeze_result', ok: true, targetId });
    this.broadcast({
      t: 'event',
      kind: { kind: 'saved', saviorId: savior.id, victimId: victim.id },
    });
  }

  private canTag(attacker: PlayerState, victim: PlayerState): boolean {
    if (attacker.team === victim.team) return false;
    if (attacker.frozen) return false;
    if (victim.frozen) return false;
    if (this.phase !== `turn_${attacker.team}`) return false;
    const d = topologyDistance(attacker.position, victim.position, this.topology, WORLD_WIDTH);
    return d <= TAG_RADIUS;
  }

  private tally(team: Team): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n += 1;
    return n;
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

  private startCountdown(): void {
    this.firstTeam = Math.random() < 0.5 ? 'mime' : 'clown';
    this.phase = 'countdown';
    this.turnEndsAt = Date.now() + COUNTDOWN_MS;
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    const now = Date.now();
    if (this.phase === 'countdown' && now >= this.turnEndsAt) {
      this.phase = 'free_roam';
      this.turnEndsAt = now + FREE_ROAM_MS;
      this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
    } else if (this.phase === 'free_roam' && now >= this.turnEndsAt) {
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
  }

  private simulateHumans(dt: number): void {
    for (const [id, input] of this.lastInputs) {
      const p = this.players.get(id);
      if (!p || p.bot || p.frozen) continue;
      const wantSprint = input.sprint && p.sprintEnergy > 0;
      const speed = wantSprint ? SPRINT_SPEED : WALK_SPEED;
      const moveLen = Math.hypot(input.move.x, input.move.z);
      const nx = moveLen > 0 ? input.move.x / moveLen : 0;
      const nz = moveLen > 0 ? input.move.z / moveLen : 0;
      const dx = nx * speed * dt;
      const dz = nz * speed * dt;
      const travel = Math.hypot(dx, dz);
      const scale = travel > MAX_TICK_TRAVEL * dt ? (MAX_TICK_TRAVEL * dt) / travel : 1;
      const candidates: Array<{ x: number; z: number }> = [
        { x: p.position.x + dx * scale, z: p.position.z + dz * scale },
        { x: p.position.x + Math.sign(dx) * speed * dt, z: p.position.z },
        { x: p.position.x, z: p.position.z + Math.sign(dz) * speed * dt },
      ];
      // Server-side wall and personal-space gate. Tries the direct move first,
      // then X-only and Z-only slides. Any accepted move must clear walls
      // and not push the player into another body. Without this the server
      // accepted any position the client computed, which made rubber-banding
      // and same-team overlap show up on every other client.
      for (const candidate of candidates) {
        if (candidate.x === p.position.x && candidate.z === p.position.z) continue;
        if (
          this.walls.length > 0 &&
          pathCrossesWall(this.walls, p.position.x, p.position.z, candidate.x, candidate.z)
        )
          continue;
        if (this.collidesWithOtherPlayer(p, candidate.x, candidate.z)) continue;
        p.position = wrapPosition(candidate, this.topology, WORLD_WIDTH);
        break;
      }
      p.yaw = input.lookYaw;
      const drained = wantSprint && moveLen > 0;
      p.sprintEnergy = clamp(
        p.sprintEnergy + (drained ? -SPRINT_DRAIN_PER_S : SPRINT_REGEN_PER_S) * dt,
        0,
        MAX_SPRINT,
      );
    }
  }

  private simulateBots(dt: number): void {
    const active = this.activeTurnTeam();
    const now = Date.now();
    const DIR_SMOOTHING = 0.35; // 0 = no smoothing, 1 = ignore new direction
    const RETARGET_HYSTERESIS = 0.75; // new target must be this fraction of current distance to swap
    for (const bot of this.botPlayers()) {
      if (bot.frozen) continue;
      const mind = this.botMinds.get(bot.id) ?? {
        patrolTarget: this.randomPatrolPoint(),
        patrolUntil: 0,
        engagedTargetId: null,
        lastDir: { x: 0, z: 0 },
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

      const chasing = target !== null && enemyDist < BOT_VISION_RADIUS && active === bot.team;
      const fleeing =
        target !== null && enemyDist < BOT_VISION_RADIUS && active && active !== bot.team;

      let dir = { x: 0, z: 0 };
      if (chasing && target) {
        dir = unitDelta(bot.position, target.position);
      } else if (fleeing && target) {
        const away = unitDelta(target.position, bot.position);
        dir = away;
      } else {
        if (now >= mind.patrolUntil || nearTarget(bot.position, mind.patrolTarget)) {
          mind.patrolTarget = this.randomPatrolPoint();
          mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
        }
        dir = unitDelta(bot.position, mind.patrolTarget);
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
      // sprinting human could never be caught or escape from.
      const wantSprint =
        (chasing || fleeing) &&
        enemyDist < BOT_SPRINT_TRIGGER_RADIUS &&
        bot.sprintEnergy > MAX_SPRINT * 0.15;
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
        bot.yaw = Math.atan2(-candidate.chosen.x, -candidate.chosen.z);
        moved = true;
        break;
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
        bot.yaw = Math.atan2(-dir.x, -dir.z);
      }

      if (chasing && target && enemyDist <= TAG_RADIUS && this.canTag(bot, target)) {
        target.frozen = true;
        this.broadcast({
          t: 'event',
          kind: { kind: 'tagged', attackerId: bot.id, victimId: target.id, team: bot.team },
        });
        this.checkWin();
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
      const last = this.lastInputs.get(conn.playerId);
      this.send(conn.ws, {
        t: 'delta',
        players,
        phase: this.phase,
        turnEndsAt: this.turnEndsAt,
        ackSeq: last?.seq ?? 0,
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

function unitDelta(
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return { x: 0, z: 0 };
  return { x: dx / len, z: dz / len };
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
