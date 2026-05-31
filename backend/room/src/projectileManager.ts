// Server-side projectile lifecycle, lifted out of Room the same way
// TagManager owns tag/freeze. The pure flight + collision math lives in
// @cm/shared/projectiles; this file owns the state-mutating side: the
// shoot handler (turn / cooldown / frozen / direction validation), the
// per-tick advance, freezing victims, and broadcasting events.
//
// Construction takes a ProjectileManagerHost so Room's other concerns
// stay decoupled, matching TagManager / GameSimulation.

import type { PlayerState, Projectile, RoomPhase, ServerToClient, Topology } from '@cm/shared';
import {
  spawnProjectile,
  stepProjectiles,
  PROJECTILE_CLIENT_CLOCK_SKEW_MS,
  PROJECTILE_HIT_RADIUS,
  SHOOT_COOLDOWN_MS,
} from '@cm/shared/projectiles';
import type { WallSegment } from '@cm/shared/labyrinth';

export interface ProjectileManagerHost {
  readonly players: Map<string, PlayerState>;
  // Wall-clock ms each player was last unfrozen. A target inside its
  // just-saved grace window is immune, matching the touch-tag rule.
  readonly lastSavedAt: Map<string, number>;
  readonly connections: Map<WebSocket, { playerId: string }>;
  readonly worldWidth: number;
  readonly unfreezeGraceMs: number;
  getWalls(): readonly WallSegment[];
  getTopology(): Topology;
  getPhase(): RoomPhase;
  broadcast(msg: ServerToClient): void;
  send(ws: WebSocket, msg: ServerToClient): void;
  freezePlayer(p: PlayerState): void;
  checkWin(): void;
}

export class ProjectileManager {
  private readonly projectiles = new Map<string, Projectile>();
  // Last shot wall-clock per shooter. Drives the cooldown gate; persists
  // across freeze/save (never cleared on those), reset only on match start.
  private readonly lastShotAt = new Map<string, number>();

  constructor(private readonly host: ProjectileManagerHost) {}

  /**
   * Validate and fire a projectile. Rejection reasons forwarded in
   * shoot_result so the client can surface why a shot didn't fire:
   * 'frozen', 'wrong_turn', 'cooldown', 'bad_direction'. The cooldown
   * uses the server clock, not the client-stamped nowMs, so a client
   * can't shrink its own cooldown.
   */
  onShoot(ws: WebSocket, dir: { x: number; y: number; z: number }, clientNowMs: number): void {
    const conn = this.host.connections.get(ws);
    if (!conn) return;
    const attacker = this.host.players.get(conn.playerId);
    if (!attacker) return;
    if (attacker.frozen) {
      this.host.send(ws, { t: 'shoot_result', ok: false, reason: 'frozen' });
      return;
    }
    if (this.host.getPhase() !== `turn_${attacker.team}`) {
      this.host.send(ws, { t: 'shoot_result', ok: false, reason: 'wrong_turn' });
      return;
    }
    const serverNow = Date.now();
    const overcharged = attacker.overchargeArmed === true;
    const last = this.lastShotAt.get(attacker.id);
    if (!overcharged && last !== undefined && serverNow - last < SHOOT_COOLDOWN_MS) {
      this.host.send(ws, { t: 'shoot_result', ok: false, reason: 'cooldown' });
      return;
    }
    // Stamp spawnedAt with the client's clock so its predicted trail lines
    // up with ours, but clamp to the server clock to bound skew.
    const skew = Math.abs(clientNowMs - serverNow);
    const spawnNowMs = skew > PROJECTILE_CLIENT_CLOCK_SKEW_MS ? serverNow : clientNowMs;
    const id = crypto.randomUUID();
    const proj = spawnProjectile(attacker, dir, id, serverNow, spawnNowMs);
    if (proj === null) {
      this.host.send(ws, { t: 'shoot_result', ok: false, reason: 'bad_direction' });
      return;
    }
    if (overcharged) {
      proj.piercing = true;
      delete attacker.overchargeArmed;
    }
    this.lastShotAt.set(attacker.id, serverNow);
    this.projectiles.set(id, proj);
    this.host.send(ws, { t: 'shoot_result', ok: true, projectileId: id });
    this.host.broadcast({ t: 'event', kind: { kind: 'projectile_fired', projectile: proj } });
  }

  /**
   * Advance every projectile one tick. Survivors replace the map; each
   * terminated projectile broadcasts projectile_hit. An enemy hit also
   * freezes the victim via the standard tagged path and checks the win
   * condition, so existing freeze handlers fire unchanged.
   */
  step(dt: number): void {
    if (this.projectiles.size === 0) return;
    const nowMs = Date.now();
    const targets = [...this.host.players.values()].map((p) => ({
      id: p.id,
      team: p.team,
      position: p.position,
      frozen: p.frozen,
    }));
    const result = stepProjectiles([...this.projectiles.values()], targets, {
      dt,
      nowMs,
      walls: this.host.getWalls(),
      topology: this.host.getTopology(),
      worldWidth: this.host.worldWidth,
      hitRadius: PROJECTILE_HIT_RADIUS,
      savedAt: (id) => this.host.lastSavedAt.get(id),
      unfreezeGraceMs: this.host.unfreezeGraceMs,
    });
    this.projectiles.clear();
    for (const proj of result.survivors) this.projectiles.set(proj.id, proj);
    for (const hit of result.hits) {
      this.host.broadcast({
        t: 'event',
        kind: { kind: 'projectile_hit', projectileId: hit.projectileId, victimId: hit.victimId },
      });
      if (hit.victimId === undefined) continue;
      const victim = this.host.players.get(hit.victimId);
      if (!victim || victim.frozen) continue;
      this.host.freezePlayer(victim);
      this.host.broadcast({
        t: 'event',
        kind: { kind: 'tagged', attackerId: hit.ownerId, victimId: victim.id, team: hit.team },
      });
      this.host.checkWin();
    }
  }

  /** Live projectiles, broadcast in the delta when non-empty. */
  getProjectiles(): Projectile[] {
    return [...this.projectiles.values()];
  }

  /** Drop all projectiles and per-shooter cooldowns. Called on match start. */
  clear(): void {
    this.projectiles.clear();
    this.lastShotAt.clear();
  }
}
