// Turn-flip anticipation for the bot AI. This is turn-based tag: on its own turn
// a bot is the hunter (chases), on the enemy's turn it's the prey (flees). When
// the turn is about to flip the two roles want opposite positions, so
// turnFlipReposition returns the pre-position target (or null to leave normal
// chase/flee alone):
//
//  - botIsHunter (own turn, about to become prey): if it can't land the tag
//    before the flip it heads AWAY from the enemy for a head start as prey; if
//    it's already in tag range it returns null and finishes the tag.
//  - prey (enemy turn, about to become hunter): it closes to a standoff ring
//    sized so the still-active hunter can't reach it before the flip (tagRadius +
//    buffer + how far that hunter can sprint in the time left), so it stays safe
//    yet is poised to pounce the instant it becomes the hunter.
//
// Pure: mirrored by game/scripts/bot_turn_flip.gd and locked by the fixture.

import type { Topology, Vec2 } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedUnitDelta } from '@cm/shared/topology';

export interface TurnFlipParams {
  anticipateMs: number;
  tagRadius: number;
  standoffBuffer: number;
  // How far the still-active hunter can travel per second; sizes the safe ring.
  sprintSpeed: number;
  // How far a retreating soon-to-be-prey aims to open up.
  fleeProjection: number;
}

export function turnFlipReposition(
  botPos: Vec2,
  enemyPos: Vec2,
  timeToFlipMs: number,
  botIsHunter: boolean,
  topology: Topology,
  worldWidth: number,
  params: TurnFlipParams,
): Vec2 | null {
  if (timeToFlipMs <= 0 || timeToFlipMs >= params.anticipateMs) return null;
  const outward = wrappedUnitDelta(enemyPos, botPos, topology, worldWidth); // enemy -> bot
  if (outward.x === 0 && outward.z === 0) return null;
  if (botIsHunter) {
    // About to become prey: bail only if the tag won't land in time.
    if (topologyDistance(botPos, enemyPos, topology, worldWidth) <= params.tagRadius) return null;
    return wrapPosition(
      {
        x: botPos.x + outward.x * params.fleeProjection,
        z: botPos.z + outward.z * params.fleeProjection,
      },
      topology,
      worldWidth,
    );
  }
  // About to become hunter: hold at a ring the hunter can't close in time.
  const standoff =
    params.tagRadius + params.standoffBuffer + params.sprintSpeed * (timeToFlipMs / 1000);
  return wrapPosition(
    { x: enemyPos.x + outward.x * standoff, z: enemyPos.z + outward.z * standoff },
    topology,
    worldWidth,
  );
}
