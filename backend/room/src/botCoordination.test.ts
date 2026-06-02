import { describe, expect, it } from 'vitest';
import type { PlayerState, Team } from '@cm/shared';
import { assignRescues } from './botCoordination.ts';

function player(over: {
  id: string;
  team: Team;
  position?: { x: number; z: number };
  frozen?: boolean;
}): PlayerState {
  return {
    id: over.id,
    name: over.id,
    team: over.team,
    bot: true,
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
