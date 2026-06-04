import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@cm/shared';
import { turnFlipReposition, type TurnFlipParams } from './botTurnFlip.ts';

const PARAMS: TurnFlipParams = {
  anticipateMs: 800,
  tagRadius: 1.4,
  standoffBuffer: 1,
  sprintSpeed: 5.6,
  fleeProjection: 12,
};

const reposition = (bot: Vec2, enemy: Vec2, timeToFlipMs: number, botIsHunter: boolean) =>
  turnFlipReposition(bot, enemy, timeToFlipMs, botIsHunter, 'plane', 80, PARAMS);

describe('turnFlipReposition', () => {
  it('retreats a soon-to-be-prey hunter that cannot land the tag in time', () => {
    // Enemy at +x; retreat aims a flee-projection out along -x.
    const t = reposition({ x: 0, z: 0 }, { x: 5, z: 0 }, 400, true);
    expect(t?.x).toBeCloseTo(-12, 4);
    expect(t?.z).toBeCloseTo(0, 4);
  });

  it('leaves a hunter already in tag range alone (finish the tag)', () => {
    expect(reposition({ x: 0, z: 0 }, { x: 1, z: 0 }, 400, true)).toBeNull();
  });

  it('closes a soon-to-be-hunter prey to the standoff ring', () => {
    // standoff = 1.4 + 1 + 5.6*0.4 = 4.64 from the enemy, on the bot's side.
    const t = reposition({ x: 0, z: 0 }, { x: 10, z: 0 }, 400, false);
    expect(t?.x).toBeCloseTo(5.36, 4);
    expect(t?.z).toBeCloseTo(0, 4);
  });

  it('does nothing when the flip is not imminent', () => {
    expect(reposition({ x: 0, z: 0 }, { x: 10, z: 0 }, 5000, false)).toBeNull();
  });

  it('does nothing once the flip time has passed', () => {
    expect(reposition({ x: 0, z: 0 }, { x: 10, z: 0 }, -10, false)).toBeNull();
  });
});
