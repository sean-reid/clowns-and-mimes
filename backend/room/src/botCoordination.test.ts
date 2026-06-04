import { describe, expect, it } from 'vitest';
import type { PlayerState, Team } from '@cm/shared';
import { assignChases, assignRescues } from './botCoordination.ts';
import { topologyDistance } from '@cm/shared/topology';

function player(over: {
  id: string;
  team: Team;
  position?: { x: number; z: number };
  frozen?: boolean;
  bot?: boolean;
}): PlayerState {
  return {
    id: over.id,
    name: over.id,
    team: over.team,
    bot: over.bot ?? true,
    position: { x: over.position?.x ?? 0, y: 0.5, z: over.position?.z ?? 0 },
    yaw: 0,
    frozen: over.frozen ?? false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  };
}

const VISION = 22;
const assign = (roster: PlayerState[]) => assignRescues(roster, 'plane', 80, VISION);
const chase = (roster: PlayerState[]) => assignChases(roster, [], 'plane', 80, 1000, VISION);

describe('assignRescues', () => {
  it('assigns a lone frozen ally to the only free bot', () => {
    const bot = player({ id: 'b', team: 'mime', position: { x: 0, z: 0 } });
    const ally = player({ id: 'a', team: 'mime', position: { x: 5, z: 0 }, frozen: true });
    const claims = assign([bot, ally]);
    expect(claims.get('b')?.target.id).toBe('a');
    expect(claims.get('b')?.dist).toBeCloseTo(5, 6);
  });

  it('spreads two bots across two frozen allies instead of swarming the nearest', () => {
    // Both bots sit near ally a1; without coordination both would take it.
    const b1 = player({ id: 'b1', team: 'mime', position: { x: 0, z: 0 } });
    const b2 = player({ id: 'b2', team: 'mime', position: { x: 1, z: 0 } });
    const a1 = player({ id: 'a1', team: 'mime', position: { x: 3, z: 0 }, frozen: true });
    const a2 = player({ id: 'a2', team: 'mime', position: { x: 12, z: 0 }, frozen: true });
    const claims = assign([b1, b2, a1, a2]);
    // Closest overall pair is (b2,a1) at 2, so b2 takes a1 and b1 takes a2 -
    // the two bots end up on distinct allies rather than both on a1.
    expect(claims.get('b2')?.target.id).toBe('a1');
    expect(claims.get('b1')?.target.id).toBe('a2');
  });

  it('leaves surplus bots unassigned when allies run out', () => {
    const b1 = player({ id: 'b1', team: 'mime', position: { x: 0, z: 0 } });
    const b2 = player({ id: 'b2', team: 'mime', position: { x: 2, z: 0 } });
    const a1 = player({ id: 'a1', team: 'mime', position: { x: 1, z: 0 }, frozen: true });
    const claims = assign([b1, b2, a1]);
    // a1 goes to its closest bot (b1); b2 has nothing to rescue.
    expect(claims.get('b1')?.target.id).toBe('a1');
    expect(claims.has('b2')).toBe(false);
  });

  it('never claims an enemy team ally, a non-frozen ally, or a frozen rescuer', () => {
    const bot = player({ id: 'b', team: 'mime', position: { x: 0, z: 0 } });
    const enemyFrozen = player({ id: 'e', team: 'clown', position: { x: 2, z: 0 }, frozen: true });
    const awake = player({ id: 'w', team: 'mime', position: { x: 2, z: 0 } });
    const frozenBot = player({ id: 'fb', team: 'mime', position: { x: 30, z: 0 }, frozen: true });
    const claims = assign([bot, enemyFrozen, awake, frozenBot]);
    // Only the far frozen teammate qualifies, but it is beyond vision -> nothing.
    expect(claims.has('b')).toBe(false);
  });

  it('ignores frozen allies beyond the vision radius', () => {
    const bot = player({ id: 'b', team: 'mime', position: { x: 0, z: 0 } });
    const ally = player({ id: 'a', team: 'mime', position: { x: 30, z: 0 }, frozen: true });
    expect(assign([bot, ally]).has('b')).toBe(false);
  });

  it('is independent of roster order', () => {
    const b1 = player({ id: 'b1', team: 'mime', position: { x: 0, z: 0 } });
    const b2 = player({ id: 'b2', team: 'mime', position: { x: 10, z: 0 } });
    const a1 = player({ id: 'a1', team: 'mime', position: { x: 2, z: 0 }, frozen: true });
    const a2 = player({ id: 'a2', team: 'mime', position: { x: 8, z: 0 }, frozen: true });
    const forward = assign([b1, b2, a1, a2]);
    const reversed = assign([a2, a1, b2, b1]);
    expect(forward.get('b1')?.target.id).toBe(reversed.get('b1')?.target.id);
    expect(forward.get('b2')?.target.id).toBe(reversed.get('b2')?.target.id);
  });
});

describe('assignChases', () => {
  it('does not claim a lone chaser (it drives straight at the target)', () => {
    const b = player({ id: 'b', team: 'mime', position: { x: 0, z: 0 } });
    const e = player({ id: 'e', team: 'clown', position: { x: 5, z: 0 }, bot: false });
    expect(chase([b, e]).size).toBe(0);
  });

  it('does not claim bots chasing separate targets', () => {
    const b1 = player({ id: 'b1', team: 'mime', position: { x: 0, z: 0 } });
    const e1 = player({ id: 'e1', team: 'clown', position: { x: 3, z: 0 }, bot: false });
    const b2 = player({ id: 'b2', team: 'mime', position: { x: 0, z: 20 } });
    const e2 = player({ id: 'e2', team: 'clown', position: { x: 3, z: 20 }, bot: false });
    expect(chase([b1, e1, b2, e2]).size).toBe(0);
  });

  it('fans two co-chasers onto opposite sides of the target (pincer)', () => {
    // Both bots sit on the -x side of the enemy; one keeps the near approach,
    // the other is routed behind it.
    const b1 = player({ id: 'b1', team: 'mime', position: { x: 0, z: 0 } });
    const b2 = player({ id: 'b2', team: 'mime', position: { x: 1, z: 0 } });
    const e = player({ id: 'e', team: 'clown', position: { x: 10, z: 0 }, bot: false });
    const claims = chase([b1, b2, e]);
    expect(claims.size).toBe(2);
    expect(claims.get('b1')?.targetId).toBe('e');
    expect(claims.get('b2')?.targetId).toBe('e');
    // The two flank goals sit on a ring around the enemy at distinct angles, so
    // their goals differ and one is on the far (x > enemy) side.
    const g1 = claims.get('b1')!.goal;
    const g2 = claims.get('b2')!.goal;
    expect(topologyDistance(g1, g2, 'plane', 80)).toBeGreaterThan(2);
    const farthest = Math.max(g1.x, g2.x);
    expect(farthest).toBeGreaterThan(10);
  });

  it('ignores frozen bots as chasers', () => {
    const b1 = player({ id: 'b1', team: 'mime', position: { x: 0, z: 0 } });
    const b2 = player({ id: 'b2', team: 'mime', position: { x: 1, z: 0 }, frozen: true });
    const e = player({ id: 'e', team: 'clown', position: { x: 10, z: 0 }, bot: false });
    // Only b1 is an active chaser, so the group is size 1 and unclaimed.
    expect(chase([b1, b2, e]).size).toBe(0);
  });
});
