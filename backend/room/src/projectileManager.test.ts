import { describe, expect, it } from 'vitest';
import type { PlayerState, RoomPhase, ServerToClient, Team } from '@cm/shared';
import { HOVER_HEIGHT } from '@cm/shared/physics';
import { ProjectileManager, type ProjectileManagerHost } from './projectileManager.ts';

function makePlayer(
  id: string,
  team: Team,
  x: number,
  over: Partial<PlayerState> = {},
): PlayerState {
  return {
    id,
    name: id,
    team,
    bot: false,
    position: { x, y: HOVER_HEIGHT, z: 0 },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
    ...over,
  };
}

interface Harness {
  pm: ProjectileManager;
  host: ProjectileManagerHost;
  ws: WebSocket;
  sent: ServerToClient[];
  broadcasts: ServerToClient[];
  players: Map<string, PlayerState>;
  setPhase: (p: RoomPhase) => void;
}

function harness(shooter: PlayerState): Harness {
  const players = new Map<string, PlayerState>([[shooter.id, shooter]]);
  const ws = {} as WebSocket;
  const connections = new Map<WebSocket, { playerId: string }>([[ws, { playerId: shooter.id }]]);
  const sent: ServerToClient[] = [];
  const broadcasts: ServerToClient[] = [];
  let phase: RoomPhase = 'turn_mime';
  const host: ProjectileManagerHost = {
    players,
    lastSavedAt: new Map(),
    connections,
    worldWidth: 80,
    unfreezeGraceMs: 1500,
    getWalls: () => [],
    getTopology: () => 'plane',
    getPhase: () => phase,
    broadcast: (msg) => broadcasts.push(msg),
    send: (_ws, msg) => sent.push(msg),
    freezePlayer: (p) => {
      p.frozen = true;
    },
    checkWin: () => {},
  };
  return {
    pm: new ProjectileManager(host),
    host,
    ws,
    sent,
    broadcasts,
    players,
    setPhase: (p) => {
      phase = p;
    },
  };
}

describe('ProjectileManager.onShoot', () => {
  it('rejects when it is not the shooter team turn', () => {
    const h = harness(makePlayer('m', 'mime', 0));
    h.setPhase('turn_clown');
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    expect(h.sent).toEqual([{ t: 'shoot_result', ok: false, reason: 'wrong_turn' }]);
    expect(h.pm.getProjectiles()).toHaveLength(0);
  });

  it('rejects a frozen shooter', () => {
    const h = harness(makePlayer('m', 'mime', 0, { frozen: true }));
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    expect(h.sent).toEqual([{ t: 'shoot_result', ok: false, reason: 'frozen' }]);
  });

  it('rejects a degenerate direction', () => {
    const h = harness(makePlayer('m', 'mime', 0));
    h.pm.onShoot(h.ws, { x: 0, y: 0, z: 0 }, Date.now());
    expect(h.sent).toEqual([{ t: 'shoot_result', ok: false, reason: 'bad_direction' }]);
  });

  it('rejects a second shot inside the cooldown', () => {
    const h = harness(makePlayer('m', 'mime', 0));
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    expect(h.sent[1]).toEqual({ t: 'shoot_result', ok: false, reason: 'cooldown' });
    expect(h.pm.getProjectiles()).toHaveLength(1);
  });

  it('fires a projectile and broadcasts projectile_fired', () => {
    const h = harness(makePlayer('m', 'mime', 0));
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    const ack = h.sent[0] as { t: string; ok: boolean; projectileId?: string };
    expect(ack).toMatchObject({ t: 'shoot_result', ok: true });
    expect(ack.projectileId).toBeDefined();
    expect(h.pm.getProjectiles()).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({ t: 'event', kind: { kind: 'projectile_fired' } });
  });

  it('an overcharged shot bypasses the cooldown, pierces, and consumes the flag', () => {
    const shooter = makePlayer('m', 'mime', 0, { overchargeArmed: true });
    const h = harness(shooter);
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    // Back-to-back second shot would normally be rejected for cooldown.
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    expect((h.sent[0] as { ok: boolean }).ok).toBe(true);
    const fired = h.broadcasts[0] as { kind: { projectile: { piercing?: boolean } } };
    expect(fired.kind.projectile.piercing).toBe(true);
    // Flag consumed: the very next shot falls back to the normal cooldown gate.
    expect(shooter.overchargeArmed).toBeUndefined();
    expect((h.sent[1] as { ok: boolean; reason?: string }).reason).toBe('cooldown');
  });
});

describe('ProjectileManager.step', () => {
  it('freezes an enemy in the path and broadcasts the freeze', () => {
    const shooter = makePlayer('m', 'mime', 0);
    const h = harness(shooter);
    const enemy = makePlayer('c', 'clown', 1.0);
    h.players.set(enemy.id, enemy);
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    h.pm.step(1 / 60);
    expect(enemy.frozen).toBe(true);
    expect(h.pm.getProjectiles()).toHaveLength(0);
    const kinds = h.broadcasts.map((m) => (m as { kind?: { kind: string } }).kind?.kind);
    expect(kinds).toContain('projectile_fired');
    expect(kinds).toContain('projectile_hit');
    expect(kinds).toContain('tagged');
  });

  it('clear() drops live projectiles and resets cooldown', () => {
    const h = harness(makePlayer('m', 'mime', 0));
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    expect(h.pm.getProjectiles()).toHaveLength(1);
    h.pm.clear();
    expect(h.pm.getProjectiles()).toHaveLength(0);
    // Cooldown reset: an immediate next shot is accepted.
    h.pm.onShoot(h.ws, { x: 1, y: 0, z: 0 }, Date.now());
    expect((h.sent[h.sent.length - 1] as { ok: boolean }).ok).toBe(true);
  });
});
