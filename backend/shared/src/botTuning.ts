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
export const BOT_SHOOT_RANGE = 18;
export const BOT_SHOOT_AIM_JITTER = 0.09;
export const RETARGET_HYSTERESIS = 0.75;
export const BOT_INVESTIGATE_MS = 3000;

// Movement / steering.
export const BOT_SPRINT_TRIGGER_RADIUS = 10;
export const BOT_FLEE_PROJECTION = 12;
export const DIR_SMOOTHING = 0.5;
export const MAX_YAW_RATE = 9.0;

// Patrol + stuck detection.
export const BOT_PATROL_RETARGET_MS = 4000;
export const BOT_PATROL_CANDIDATE_ATTEMPTS = 8;
export const BOT_NO_PROGRESS_WINDOW_MS = 800;
export const BOT_NO_PROGRESS_MIN_DIST = 0.5;
export const BOT_RECENT_TARGETS_KEEP = 6;
export const BOT_RECENT_TARGET_RADIUS = 10;

// Item seeking.
export const BOT_ITEM_SEEK_RADIUS = 16;

// Jump triggers.
export const BOT_JUMP_REFRACTORY_MS = 1500;
export const BOT_JUMP_NOISE_PER_SECOND = 0.05;
export const BOT_JUMP_EVADE_BUFFER = 0.5;
export const BOT_JUMP_CORNER_THREAT_RADIUS = 4.0;

// Clone power-up ally lifetime + spawn offset.
export const CLONE_DURATION_MS = 30000;
export const CLONE_SPAWN_OFFSET = 2.0;

// Weighted-A* path costs. A cell walled on more sides costs a little more so
// routes lean toward open space; a cell holding another player costs a lot more
// (soft, not a hard block) so bots route around each other. Tuned in playtest.
export const WALL_AVOID_WEIGHT = 0.5;
export const OCCUPANCY_WEIGHT = 6;
