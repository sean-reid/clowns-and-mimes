import { describe, expect, it } from 'vitest';
import type { Projectile, Team } from './protocol.ts';
import { HOVER_HEIGHT, BODY_VERTICAL_EXTENT } from './physics.ts';
import { PLAYER_RADIUS, type WallSegment } from './labyrinth.ts';
import {
  spawnProjectile,
  stepProjectiles,
  type ProjectileStepContext,
  type ProjectileTarget,
  PROJECTILE_HIT_RADIUS,
  PROJECTILE_LIFETIME_MS,
  PROJECTILE_SPEED,
  PROJECTILE_SPAWN_OFFSET,
} from './projectiles.ts';

const NOW = 1_000_000;

function ctx(over: Partial<ProjectileStepContext> = {}): ProjectileStepContext {
  return {
    dt: 1 / 60,
    nowMs: NOW,
    walls: [],
    topology: 'plane',
    worldWidth: 80,
    hitRadius: PROJECTILE_HIT_RADIUS,
    savedAt: () => undefined,
    unfreezeGraceMs: 1500,
    ...over,
  };
}

function proj(over: Partial<Projectile> = {}): Projectile {
  return {
    id: 'p1',
    ownerId: 'owner',
    team: 'mime',
    position: { x: 0, y: HOVER_HEIGHT, z: 0 },
    velocity: { x: PROJECTILE_SPEED, y: 0, z: 0 },
    spawnedAt: NOW,
    expiresAt: NOW + PROJECTILE_LIFETIME_MS,
    ...over,
  };
}

function target(over: Partial<ProjectileTarget> = {}): ProjectileTarget {
  return {
    id: 'enemy',
    team: 'clown',
    position: { x: 50, y: HOVER_HEIGHT, z: 0 },
    frozen: false,
    ...over,
  };
}

describe('spawnProjectile', () => {
  const owner = { id: 'o', team: 'mime' as Team, position: { x: 1, y: HOVER_HEIGHT, z: 2 } };

  it('returns null for a degenerate direction', () => {
    expect(spawnProjectile(owner, { x: 0, y: 0, z: 0 }, 'p', NOW, NOW)).toBeNull();
  });

  it('normalizes velocity to PROJECTILE_SPEED', () => {
    const p = spawnProjectile(owner, { x: 0, y: 0, z: 4 }, 'p', NOW, NOW)!;
    const speed = Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z);
    expect(speed).toBeCloseTo(PROJECTILE_SPEED, 6);
    expect(p.velocity.z).toBeCloseTo(PROJECTILE_SPEED, 6);
  });

  it('spawns ahead of the owner by the spawn offset', () => {
    const p = spawnProjectile(owner, { x: 0, y: 0, z: 1 }, 'p', NOW, NOW)!;
    expect(p.position.z).toBeCloseTo(2 + PROJECTILE_SPAWN_OFFSET, 6);
    expect(p.position.x).toBeCloseTo(1, 6);
  });

  it('stamps client spawn time but server-driven expiry', () => {
    const p = spawnProjectile(owner, { x: 1, y: 0, z: 0 }, 'p', NOW, NOW - 250)!;
    expect(p.spawnedAt).toBe(NOW - 250);
    expect(p.expiresAt).toBe(NOW + PROJECTILE_LIFETIME_MS);
  });
});

describe('stepProjectiles', () => {
  it('expires a projectile past its lifetime with no victim', () => {
    const r = stepProjectiles([proj({ expiresAt: NOW - 1 })], [], ctx());
    expect(r.survivors).toHaveLength(0);
    expect(r.hits).toEqual([{ projectileId: 'p1', ownerId: 'owner', team: 'mime' }]);
  });

  it('dissipates on a wall crossing with no victim', () => {
    const wall: WallSegment = { ax: 0.1, az: -1, bx: 0.1, bz: 1 };
    const r = stepProjectiles([proj()], [target()], ctx({ walls: [wall] }));
    expect(r.survivors).toHaveLength(0);
    expect(r.hits[0]).toMatchObject({ projectileId: 'p1' });
    expect(r.hits[0]!.victimId).toBeUndefined();
  });

  it('freezes an enemy within the hit radius', () => {
    const candidateX = PROJECTILE_SPEED * (1 / 60);
    const r = stepProjectiles(
      [proj()],
      [target({ position: { x: candidateX, y: HOVER_HEIGHT, z: 0 } })],
      ctx(),
    );
    expect(r.survivors).toHaveLength(0);
    expect(r.hits[0]).toMatchObject({ projectileId: 'p1', ownerId: 'owner', victimId: 'enemy' });
  });

  it('passes through a same-team target (friendly fire off)', () => {
    const candidateX = PROJECTILE_SPEED * (1 / 60);
    const r = stepProjectiles(
      [proj()],
      [target({ team: 'mime', position: { x: candidateX, y: HOVER_HEIGHT, z: 0 } })],
      ctx(),
    );
    expect(r.hits).toHaveLength(0);
    expect(r.survivors).toHaveLength(1);
  });

  it('passes through a frozen target', () => {
    const candidateX = PROJECTILE_SPEED * (1 / 60);
    const r = stepProjectiles(
      [proj()],
      [target({ frozen: true, position: { x: candidateX, y: HOVER_HEIGHT, z: 0 } })],
      ctx(),
    );
    expect(r.hits).toHaveLength(0);
    expect(r.survivors).toHaveLength(1);
  });

  it('passes through a just-saved target inside its grace window', () => {
    const candidateX = PROJECTILE_SPEED * (1 / 60);
    const r = stepProjectiles(
      [proj()],
      [target({ position: { x: candidateX, y: HOVER_HEIGHT, z: 0 } })],
      ctx({ savedAt: (id) => (id === 'enemy' ? NOW - 100 : undefined) }),
    );
    expect(r.hits).toHaveLength(0);
    expect(r.survivors).toHaveLength(1);
  });

  it('misses an enemy separated vertically beyond the body extent', () => {
    const candidateX = PROJECTILE_SPEED * (1 / 60);
    const r = stepProjectiles(
      [proj()],
      [target({ position: { x: candidateX, y: HOVER_HEIGHT + BODY_VERTICAL_EXTENT, z: 0 } })],
      ctx(),
    );
    expect(r.hits).toHaveLength(0);
    expect(r.survivors).toHaveLength(1);
  });

  it('advances a clean survivor to the candidate position', () => {
    const r = stepProjectiles([proj()], [target()], ctx());
    expect(r.hits).toHaveLength(0);
    expect(r.survivors[0]!.position.x).toBeCloseTo(PROJECTILE_SPEED * (1 / 60), 6);
  });

  it('wraps a survivor across a torus seam', () => {
    const near = proj({ position: { x: 39.9, y: HOVER_HEIGHT, z: 0 } });
    const r = stepProjectiles([near], [], ctx({ topology: 'torus', dt: 0.1 }));
    expect(r.survivors).toHaveLength(1);
    // 39.9 + 12*0.1 = 41.1 wraps to -38.9 on an 80-wide torus.
    expect(r.survivors[0]!.position.x).toBeCloseTo(-38.9, 6);
  });

  it('is deterministic across identical runs', () => {
    const make = () =>
      stepProjectiles(
        [proj()],
        [target({ position: { x: 0.5, y: HOVER_HEIGHT, z: 0 } })],
        ctx({ hitRadius: PLAYER_RADIUS }),
      );
    expect(make()).toEqual(make());
  });
});
