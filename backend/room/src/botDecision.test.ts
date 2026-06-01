import { describe, expect, it } from 'vitest';
import type { PlayerState, Team } from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import { decideBotAction, type DecisionParams, type Engagement } from './botDecision.ts';

const PARAMS: DecisionParams = {
  visionRadius: 22,
  shootRange: 18,
  retargetHysteresis: 0.75,
  investigateMs: 3000,
};

function player(over: Partial<PlayerState> & Pick<PlayerState, 'id' | 'team'>): PlayerState {
  return {
    name: over.id,
    bot: false,
    position: { x: 0, y: 0.5, z: 0 },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
    ...over,
  } as PlayerState;
}

function freshEngagement(): Engagement {
  return { engagedTargetId: null, lastKnownPos: null, investigateUntil: 0 };
}

function decide(
  bot: PlayerState,
  roster: PlayerState[],
  active: Team | null,
  eng: Engagement,
  walls: WallSegment[] = [],
  now = 1000,
) {
  return decideBotAction(bot, roster, walls, 'plane', 80, now, active, eng, PARAMS);
}

const bot = () => player({ id: 'bot', team: 'mime', position: { x: 0, y: 0.5, z: 0 } });

describe('decideBotAction movement mode', () => {
  it('patrols with no enemy and no frozen ally', () => {
    const d = decide(bot(), [bot()], 'mime', freshEngagement());
    expect(d.mode).toBe('patrol');
    expect(d.chasing).toBe(false);
    expect(d.fleeing).toBe(false);
    expect(d.rescuing).toBe(false);
  });

  it('chases a visible enemy on its own turn', () => {
    const b = bot();
    const enemy = player({ id: 'e', team: 'clown', position: { x: 5, y: 0.5, z: 0 } });
    const eng = freshEngagement();
    const d = decide(b, [b, enemy], 'mime', eng);
    expect(d.mode).toBe('chase');
    expect(d.chasing).toBe(true);
    expect(d.target?.id).toBe('e');
    expect(eng.engagedTargetId).toBe('e');
    expect(d.canShoot).toBe(true); // within shoot range, line of sight clear
  });

  it('flees a visible enemy on the enemy turn', () => {
    const b = bot();
    const enemy = player({ id: 'e', team: 'clown', position: { x: 5, y: 0.5, z: 0 } });
    const d = decide(b, [b, enemy], 'clown', freshEngagement());
    expect(d.mode).toBe('flee');
    expect(d.fleeing).toBe(true);
    expect(d.canShoot).toBe(false);
  });

  it('rescues a frozen ally when no enemy is in play', () => {
    const b = bot();
    const ally = player({ id: 'a', team: 'mime', position: { x: 4, y: 0.5, z: 0 }, frozen: true });
    const d = decide(b, [b, ally], 'mime', freshEngagement());
    expect(d.mode).toBe('rescue');
    expect(d.rescuing).toBe(true);
    expect(d.rescueTarget?.id).toBe('a');
  });

  it('prioritizes fleeing over rescuing, but keeps the rescue flag live', () => {
    const b = bot();
    const enemy = player({ id: 'e', team: 'clown', position: { x: 5, y: 0.5, z: 0 } });
    const ally = player({ id: 'a', team: 'mime', position: { x: 4, y: 0.5, z: 0 }, frozen: true });
    const d = decide(b, [b, enemy, ally], 'clown', freshEngagement());
    expect(d.mode).toBe('flee');
    expect(d.rescuing).toBe(true); // still true so the unfreeze action can fire
  });
});

describe('decideBotAction engagement hysteresis', () => {
  it('stays locked on the engaged target when a new one is not meaningfully closer', () => {
    const b = bot();
    const a = player({ id: 'A', team: 'clown', position: { x: 10, y: 0.5, z: 0 } });
    const bEnemy = player({ id: 'B', team: 'clown', position: { x: 8, y: 0.5, z: 0 } });
    const eng: Engagement = { engagedTargetId: 'A', lastKnownPos: null, investigateUntil: 0 };
    const d = decide(b, [b, a, bEnemy], 'mime', eng);
    // B (dist 8) is closer but 8 >= 10 * 0.75, so hysteresis keeps A.
    expect(d.target?.id).toBe('A');
  });

  it('retargets when a new enemy is well inside the hysteresis band', () => {
    const b = bot();
    const a = player({ id: 'A', team: 'clown', position: { x: 10, y: 0.5, z: 0 } });
    const bEnemy = player({ id: 'B', team: 'clown', position: { x: 6, y: 0.5, z: 0 } });
    const eng: Engagement = { engagedTargetId: 'A', lastKnownPos: null, investigateUntil: 0 };
    const d = decide(b, [b, a, bEnemy], 'mime', eng);
    // B (dist 6) < 10 * 0.75 = 7.5, so the bot switches to the closer enemy.
    expect(d.target?.id).toBe('B');
  });
});

describe('decideBotAction occlusion and investigate', () => {
  // Wall on x=3 spanning z, occluding an enemy out at x=10 from a bot at origin.
  const wall: WallSegment[] = [{ ax: 3, az: -6, bx: 3, bz: 6 }];

  it('investigates the last known position when the target ducks behind a wall on our turn', () => {
    const b = bot();
    const enemy = player({ id: 'e', team: 'clown', position: { x: 10, y: 0.5, z: 0 } });
    const eng: Engagement = { engagedTargetId: 'e', lastKnownPos: null, investigateUntil: 0 };
    const d = decide(b, [b, enemy], 'mime', eng, wall);
    expect(d.target).toBeNull();
    expect(d.mode).toBe('investigate');
    expect(eng.lastKnownPos).not.toBeNull();
    expect(eng.investigateUntil).toBeGreaterThan(1000);
  });

  it('drops the target outright when it ducks behind a wall on the enemy turn', () => {
    const b = bot();
    const enemy = player({ id: 'e', team: 'clown', position: { x: 10, y: 0.5, z: 0 } });
    const eng: Engagement = { engagedTargetId: 'e', lastKnownPos: null, investigateUntil: 0 };
    const d = decide(b, [b, enemy], 'clown', eng, wall);
    expect(d.mode).toBe('patrol');
    expect(eng.engagedTargetId).toBeNull();
  });

  it('drops a target that activates cloak, with no investigate grace', () => {
    const b = bot();
    const enemy = player({
      id: 'e',
      team: 'clown',
      position: { x: 5, y: 0.5, z: 0 },
      cloakUntil: 9999,
    });
    const eng: Engagement = { engagedTargetId: 'e', lastKnownPos: null, investigateUntil: 0 };
    const d = decide(b, [b, enemy], 'mime', eng);
    expect(d.target).toBeNull();
    expect(d.mode).toBe('patrol');
    expect(eng.engagedTargetId).toBeNull();
    expect(eng.lastKnownPos).toBeNull();
  });

  it('clears a stale investigate once its window elapses', () => {
    const b = bot();
    const eng: Engagement = {
      engagedTargetId: null,
      lastKnownPos: { x: 10, z: 0 },
      investigateUntil: 500,
    };
    const d = decide(b, [b], 'mime', eng, [], 1000); // now (1000) past investigateUntil (500)
    expect(d.mode).toBe('patrol');
    expect(eng.lastKnownPos).toBeNull();
    expect(eng.investigateUntil).toBe(0);
  });
});
