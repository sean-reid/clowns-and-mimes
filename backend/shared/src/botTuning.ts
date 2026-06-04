// Canonical bot-AI tuning constants, shared so the online brain
// (backend/room/src/botManager.ts and its layers) and the offline brain
// (game/scripts/bot_*.gd, via gen-shared-constants.mjs -> shared_constants.gd)
// read one source of truth. Keeping them here is what lets offline hold parity
// with online without hand-copied values drifting apart.
//
// Literals only (no numeric separators): the GDScript generator scrapes these
// with parseFloat, so write 3000, not 3_000.

// Tag / unfreeze reach for a bot (mirrors the rules' TAG_RADIUS).
export const TAG_RADIUS_BOT = 1.4;
export const UNFREEZE_RADIUS_BOT = 1.4;

// Perception + engagement.
export const BOT_VISION_RADIUS = 22;
// Tag-value target scoring: among visible enemies the bot engages the most
// catchable, not just the nearest. value = -distance + cornered*CORNER_WEIGHT +
// isolated*ISOLATION_WEIGHT, where cornered (0..1) is the fraction of sampled
// directions blocked by a wall within CORNER_SAMPLE_DIST, and isolated (0..1) is
// how far the enemy is from its nearest teammate (capped at vision). Weights are
// in distance units: a fully cornered enemy is worth chasing as if it were
// CORNER_WEIGHT closer; a fully isolated one, ISOLATION_WEIGHT closer.
export const BOT_TARGET_CORNER_WEIGHT = 4;
export const BOT_TARGET_ISOLATION_WEIGHT = 6;
export const BOT_TARGET_CORNER_SAMPLE_DIST = 5;
export const BOT_SHOOT_RANGE = 18;
export const BOT_SHOOT_AIM_JITTER = 0.09;
export const RETARGET_HYSTERESIS = 0.75;
export const BOT_INVESTIGATE_MS = 3000;
// Seen incoming fire (botProjectileThreat.nearestProjectileThreat). A bot can
// see an enemy projectile in flight (within BOT_VISION_RADIUS, line of sight) -
// not the muzzle flash - so it infers only the line of fire, not the exact
// source. The threat bearing is a point this far back along the projectile's
// reverse trajectory; the prey flees away from it. Kept short so the point stays
// local (no wrap-around ambiguity on a torus/Klein bottle).
export const BOT_FIRE_THREAT_LOOKBACK = 12;
// Projectile dodge (botProjectileThreat.shouldDodgeProjectile). When a visible
// enemy shot's straight-line closest approach to the bot lands within
// DODGE_RADIUS and is less than DODGE_LEAD_S away, the bot jumps to let it pass
// under - the reactive complement to fleeing the line of fire.
export const BOT_DODGE_RADIUS = 1;
export const BOT_DODGE_LEAD_S = 0.35;
// Chase coordination (botCoordination.assignChases). When two or more bots hunt
// the same enemy they're fanned out onto a ring of this radius around it at
// evenly-spaced angles, so they pincer from different sides instead of
// conga-lining in from one. The flank goal only steers the approach while the
// bot is farther than FLANK_RELEASE_DIST from the target; inside that it drives
// straight in for the tag (RELEASE > RADIUS leaves a convergence zone).
export const BOT_CHASE_FLANK_RADIUS = 4;
export const BOT_CHASE_FLANK_RELEASE_DIST = 6;

// Movement / steering.
export const BOT_SPRINT_TRIGGER_RADIUS = 10;
export const BOT_FLEE_PROJECTION = 12;
// Smart flee (botFlee.bestFleeTarget). Instead of bolting straight away from the
// threat, the bot scores a fan of CANDIDATES escape points (anchored on the
// straight-away direction) and picks the one farthest from the nearest enemy
// after penalties: WALL_PENALTY scales the dead-end cost (a wall-cornered
// destination, 0..1), BLOCKED_PENALTY all but rules out a direction with a wall
// straight in the way. On open ground the straight-away candidate still wins.
export const BOT_FLEE_CANDIDATES = 12;
export const BOT_FLEE_WALL_PENALTY = 12;
export const BOT_FLEE_BLOCKED_PENALTY = 1000;
export const DIR_SMOOTHING = 0.5;
export const MAX_YAW_RATE = 9.0;

// Patrol + stuck detection.
export const BOT_PATROL_RETARGET_MS = 4000;
export const BOT_PATROL_CANDIDATE_ATTEMPTS = 8;
export const BOT_NO_PROGRESS_WINDOW_MS = 800;
export const BOT_NO_PROGRESS_MIN_DIST = 0.5;
export const BOT_RECENT_TARGETS_KEEP = 6;
export const BOT_RECENT_TARGET_RADIUS = 10;

// Coverage-aware patrol. A patrolling bot remembers when it last visited each
// pathfinder cell and favors cells it hasn't seen in a while, plus a bias toward
// continuing its heading, so it sweeps the map instead of pacing one spot. A
// cell's staleness saturates at VISIT_DECAY_MS; MOMENTUM_BONUS weights the
// keep-going-forward term against staleness (which is 0..1).
export const BOT_PATROL_VISIT_DECAY_MS = 12000;
export const BOT_PATROL_MOMENTUM_BONUS = 0.5;
// Team-spread: a patrol candidate is penalized for sitting within SPREAD_RADIUS
// of a teammate (penalty ramps to SPREAD_WEIGHT at zero distance), so the team
// fans out across distinct regions instead of clustering.
export const BOT_PATROL_SPREAD_RADIUS = 24;
export const BOT_PATROL_SPREAD_WEIGHT = 0.7;

// Item seeking.
export const BOT_ITEM_SEEK_RADIUS = 16;
// Item denial: a reachable floor item an enemy is contesting (within
// CONTEST_RADIUS of it, and the bot no farther from it than that enemy) is worth
// a DENY_WEIGHT detour over a marginally closer uncontested item, so the bot
// snatches power-ups out from under the enemy.
export const BOT_ITEM_CONTEST_RADIUS = 12;
export const BOT_ITEM_DENY_WEIGHT = 8;

// Jump triggers.
export const BOT_JUMP_REFRACTORY_MS = 1500;
export const BOT_JUMP_NOISE_PER_SECOND = 0.05;
export const BOT_JUMP_EVADE_BUFFER = 0.5;
export const BOT_JUMP_CORNER_THREAT_RADIUS = 4.0;

// Clone power-up ally lifetime + spawn offset.
export const CLONE_DURATION_MS = 30000;
export const CLONE_SPAWN_OFFSET = 2.0;

// Weighted-A* path costs. Both wall and player avoidance are continuous
// repulsion fields layered on the unit per-cell step cost: a cell's entry cost
// rises the closer its center sits to the obstacle, ramping linearly from 0 at
// the radius down to the full weight at the obstacle. A smooth gradient (rather
// than a flat per-cell flag) steers bots toward the middle of open lanes and
// off wall edges / corners and keeps them from clustering on each other,
// trading some path length for clearance (clearance matters more than the
// strictly shortest route here).
//
// Walls (static, baked once): the playfield boundary on a non-wrapping axis
// counts as a wall too. Players (dynamic, per query): every other player -
// teammates included - is avoided so bots don't collide / stack up, yet the
// cost is soft (not a hard block) so a bot can still push through when there's
// genuinely no other way; the destination cell is never penalized so a bot can
// still close on a target standing in a crowd. The player radius is tighter
// than the wall radius: walls are bigger obstacles to give a wide berth, a
// teammate just needs not to be walked into.
//
// All live in @cm/shared/botTuning so the offline GDScript pathfinder runs the
// identical cost field. Tuned in playtest.
export const WALL_AVOID_WEIGHT = 4;
export const WALL_AVOID_RADIUS = 14;
export const OCCUPANCY_WEIGHT = 6;
export const OCCUPANCY_RADIUS = 6;
