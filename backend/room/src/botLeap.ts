// Leap traversal for the bot AI. A normal jump peaks well below WALL_HEIGHT, so
// it can never cross a wall - but a Leap power-up's arc peaks above it, and the
// movement layer stops blocking a body's XZ on walls once it's higher than the
// wall. So a bot holding a Leap can hop a wall that's in the way of a fixed
// objective (a chase target or a frozen ally) instead of taking the pathfinder's
// long way around.
//
// shouldLeapTraverse is the trigger: leaping straight at `goal` clears a wall
// when the straight hop of `reach` (about a leap's horizontal travel) crosses a
// wall yet lands on open ground past it. The caller gates this on actually
// holding a Leap and on being in a mode with a fixed goal; the steering layer
// then drives straight at the goal while airborne so the bot commits across the
// arc rather than veering onto the pathfinder's detour mid-leap. Pure: mirrored
// by game/scripts/bot_leap.gd and locked cross-language by the fixture.

import type { Topology, Vec2 } from '@cm/shared';
import { wrapPosition, wrappedUnitDelta } from '@cm/shared/topology';
import { pathCrossesWall, pointBlockedByWall, type WallSegment } from '@cm/shared/labyrinth';

export function shouldLeapTraverse(
  botPos: Vec2,
  goal: Vec2,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  reach: number,
): boolean {
  if (walls.length === 0) return false;
  const dir = wrappedUnitDelta(botPos, goal, topology, worldWidth);
  if (dir.x === 0 && dir.z === 0) return false;
  const land = wrapPosition(
    { x: botPos.x + dir.x * reach, z: botPos.z + dir.z * reach },
    topology,
    worldWidth,
  );
  // A wall must lie between the bot and the landing point (otherwise there's
  // nothing to leap), and the landing point must be clear (so the bot lands past
  // the wall rather than embedded in it).
  if (!pathCrossesWall(walls, botPos.x, botPos.z, land.x, land.z)) return false;
  return !pointBlockedByWall(walls, land.x, land.z);
}
