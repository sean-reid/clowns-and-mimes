// Tag / freeze / unfreeze handlers lifted out of Room. The pure rules
// live in @cm/shared/tagRules; this file owns the *state-mutating* side:
// wiring incoming WS messages to the rules, applying freezes, broadcasting
// events, and checking the win condition.
//
// Construction takes a TagManagerHost rather than the full Room class so
// the Room's other concerns (lifecycle, simulation, broadcast) can move
// in parallel without TagManager taking dependencies on them.

import type { PlayerState, RoomPhase, ServerToClient, Topology, Vec2 } from '@cm/shared';
import { topologyDistance } from '@cm/shared/topology';
import { pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';
import { HOVER_HEIGHT } from '@cm/shared/physics';
import { tagRejectionReason as sharedTagRejectionReason } from '@cm/shared/tagRules';

// Everything TagManager needs from Room. Defined as an interface so
// callers can supply mocks in tests without standing up the whole DO.
//
// Maps are passed by reference because Room mutates them in place but
// never reassigns. walls / topology / phase are reassigned on topology
// changes and phase transitions, so those go through getters instead
// of frozen-at-construction references.
export interface TagManagerHost {
  readonly players: Map<string, PlayerState>;
  readonly lastSavedAt: Map<string, number>;
  readonly connections: Map<WebSocket, { playerId: string }>;
  readonly worldWidth: number;
  readonly unfreezeGraceMs: number;
  readonly unfreezeRadiusClient: number;
  readonly lagCompMs: number;
  getWalls(): readonly WallSegment[];
  getTopology(): Topology;
  getPhase(): RoomPhase;
  setPhase(p: RoomPhase): void;
  positionAt(playerId: string, atMs: number): Vec2;
  broadcast(msg: ServerToClient): void;
  send(ws: WebSocket, msg: ServerToClient): void;
  stopTick(): void;
}

export class TagManager {
  constructor(private readonly host: TagManagerHost) {}

  /**
   * Returns null when the tag is legal, or a short reason string otherwise.
   * The reason is forwarded in tag_result so the HUD can surface why a tag
   * was rejected ('not_your_turn', 'out_of_range', 'wall_in_way', ...).
   *
   * lagCompensate is true for client-initiated tags only: the victim's
   * position is rewound by lagCompMs so the distance check runs against
   * the world state the client saw at the moment of the tag.
   */
  tagRejectionReason(
    attacker: PlayerState,
    victim: PlayerState,
    radius: number,
    lagCompensate: boolean,
  ): string | null {
    const victimResolvedPos2D = lagCompensate
      ? this.host.positionAt(victim.id, Date.now() - this.host.lagCompMs)
      : victim.position;
    // tagRules.ts uses Vec3 so we can plug verticallyOverlapping into it.
    // The lag-rewind only adjusts XZ; Y stays at the current value because
    // jump arcs are deterministic functions of jumpStartedAt and we want
    // the vertical-overlap check to use the latest authoritative Y.
    return sharedTagRejectionReason(attacker, victim, radius, {
      victimResolvedPos: {
        x: victimResolvedPos2D.x,
        y: victim.position.y,
        z: victimResolvedPos2D.z,
      },
      phase: this.host.getPhase(),
      victimSavedAtMs: this.host.lastSavedAt.get(victim.id),
      unfreezeGraceMs: this.host.unfreezeGraceMs,
      nowMs: Date.now(),
      walls: this.host.getWalls(),
      topology: this.host.getTopology(),
      worldWidth: this.host.worldWidth,
    });
  }

  canTag(attacker: PlayerState, victim: PlayerState, radius: number): boolean {
    return this.tagRejectionReason(attacker, victim, radius, false) === null;
  }

  /**
   * Centralised freeze. Sets `frozen = true` and cancels any active jump
   * arc so a tagged-mid-air body drops back to HOVER_HEIGHT for the
   * snapshot wire rather than freezing in place at altitude. Clients
   * render the descent as a short Y-lerp; the server's authoritative
   * position is already on the ground.
   */
  freezePlayer(p: PlayerState): void {
    p.frozen = true;
    if (p.jumpStartedAt !== null) {
      p.jumpStartedAt = null;
      p.position = { x: p.position.x, y: HOVER_HEIGHT, z: p.position.z };
    }
  }

  onTag(ws: WebSocket, targetId: string, tagRadius: number): void {
    const conn = this.host.connections.get(ws);
    if (!conn) return;
    const attacker = this.host.players.get(conn.playerId);
    const victim = this.host.players.get(targetId);
    if (!attacker || !victim) {
      this.host.send(ws, { t: 'tag_result', ok: false, reason: 'missing' });
      return;
    }
    const reason = this.tagRejectionReason(attacker, victim, tagRadius, true);
    if (reason !== null) {
      this.host.send(ws, { t: 'tag_result', ok: false, reason });
      return;
    }
    this.freezePlayer(victim);
    this.host.send(ws, { t: 'tag_result', ok: true, targetId });
    this.host.broadcast({
      t: 'event',
      kind: { kind: 'tagged', attackerId: attacker.id, victimId: victim.id, team: attacker.team },
    });
    this.checkWin();
  }

  onUnfreeze(ws: WebSocket, targetId: string): void {
    const conn = this.host.connections.get(ws);
    if (!conn) return;
    const savior = this.host.players.get(conn.playerId);
    const victim = this.host.players.get(targetId);
    if (!savior || !victim || !victim.frozen || savior.team !== victim.team) {
      this.host.send(ws, { t: 'unfreeze_result', ok: false, reason: 'invalid' });
      return;
    }
    // Lag-compensate the frozen teammate's position too: the client clicked
    // save based on where they saw the body, not where the server currently
    // has it. Frozen players don't move so this rarely matters, but staying
    // consistent with onTag keeps the rules simple.
    const victimPos = this.host.positionAt(victim.id, Date.now() - this.host.lagCompMs);
    const dist = topologyDistance(
      savior.position,
      victimPos,
      this.host.getTopology(),
      this.host.worldWidth,
    );
    if (dist > this.host.unfreezeRadiusClient) {
      this.host.send(ws, {
        t: 'unfreeze_result',
        ok: false,
        reason: `out_of_range:${dist.toFixed(2)}`,
      });
      return;
    }
    const walls = this.host.getWalls();
    if (
      walls.length > 0 &&
      pathCrossesWall(walls, savior.position.x, savior.position.z, victimPos.x, victimPos.z)
    ) {
      this.host.send(ws, { t: 'unfreeze_result', ok: false, reason: 'wall_in_way' });
      return;
    }
    victim.frozen = false;
    this.host.lastSavedAt.set(victim.id, Date.now());
    this.host.send(ws, { t: 'unfreeze_result', ok: true, targetId });
    this.host.broadcast({
      t: 'event',
      kind: { kind: 'saved', saviorId: savior.id, victimId: victim.id },
    });
  }

  /**
   * End the match when one whole team is frozen. Called after every
   * freeze (client-initiated tag, server-initiated bot tag) so we
   * never sit on a 0-active-opponent state for more than one tick.
   */
  checkWin(): void {
    const mimesActive = [...this.host.players.values()].filter(
      (p) => p.team === 'mime' && !p.frozen,
    );
    const clownsActive = [...this.host.players.values()].filter(
      (p) => p.team === 'clown' && !p.frozen,
    );
    if (mimesActive.length === 0) {
      this.host.setPhase('ended');
      this.host.broadcast({ t: 'event', kind: { kind: 'win', team: 'clown' } });
      this.host.stopTick();
    } else if (clownsActive.length === 0) {
      this.host.setPhase('ended');
      this.host.broadcast({ t: 'event', kind: { kind: 'win', team: 'mime' } });
      this.host.stopTick();
    }
  }
}
