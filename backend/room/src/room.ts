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
import { PROTOCOL_VERSION } from '@cm/shared';
import { topologyDistance, wrapPosition } from '@cm/shared/topology';
import { generateWalls, pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const FREE_ROAM_MS = 60_000;
const COUNTDOWN_MS = 10_000;
const TAG_RADIUS = 1.4;
const UNFREEZE_RADIUS = 1.4;
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
const BOT_VISION_RADIUS = 16;
const BOT_PATROL_RETARGET_MS = 4_000;

interface BotMind {
  patrolTarget: { x: number; z: number };
  patrolUntil: number;
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
      position: { x: 0, z: 0 },
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
          name: `Bot-${id.slice(0, 4)}`,
          team,
          bot: true,
          position: { x: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 },
          yaw: 0,
          frozen: false,
          sprintEnergy: MAX_SPRINT,
        });
        this.botMinds.set(id, { patrolTarget: this.randomPatrolPoint(), patrolUntil: 0 });
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
    this.broadcast({ t: 'event', kind: { kind: 'phase', phase: this.phase } });
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
      const next = { x: p.position.x + dx * scale, z: p.position.z + dz * scale };
      p.position = wrapPosition(next, this.topology, WORLD_WIDTH);
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
    for (const bot of this.botPlayers()) {
      if (bot.frozen) continue;
      const mind = this.botMinds.get(bot.id) ?? {
        patrolTarget: this.randomPatrolPoint(),
        patrolUntil: 0,
      };
      this.botMinds.set(bot.id, mind);

      const target = this.nearestVisibleEnemy(bot);
      const enemyDist = target
        ? topologyDistance(bot.position, target.position, this.topology, WORLD_WIDTH)
        : Infinity;
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

      const speed = WALK_SPEED;
      const next = {
        x: bot.position.x + dir.x * speed * dt,
        z: bot.position.z + dir.z * speed * dt,
      };
      if (
        this.walls.length > 0 &&
        pathCrossesWall(this.walls, bot.position.x, bot.position.z, next.x, next.z)
      ) {
        // Wall in the way - re-roll the patrol target so the bot does not just
        // keep grinding against the same wall every tick.
        mind.patrolTarget = this.randomPatrolPoint();
        mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
      } else {
        bot.position = wrapPosition(next, this.topology, WORLD_WIDTH);
      }
      bot.yaw = Math.atan2(-dir.x, -dir.z);

      if (chasing && target && enemyDist <= TAG_RADIUS && this.canTag(bot, target)) {
        target.frozen = true;
        this.broadcast({
          t: 'event',
          kind: { kind: 'tagged', attackerId: bot.id, victimId: target.id, team: bot.team },
        });
        this.checkWin();
      }
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
