// Deterministic power-up spawn layout shared by client and server. The server
// owns the live item state (see room/itemManager.ts); this module supplies the
// fixed floor layout (a seeded sparse subset of maze cells) and the per-match
// type rotation, both derived purely from the room seed so every client agrees
// without a round-trip.

import type { ItemType, Topology, Vec3 } from './protocol.ts';
import { WORLD_WIDTH } from './topology.ts';
import { GRID_MAZE_N } from './gridMaze.ts';
import { MOBIUS_HALF_X, MOBIUS_HALF_Z } from './mobius.ts';

// Held power-up respawns this long after pickup.
export const ITEM_RESPAWN_MS = 30_000;
// A player within this planar distance of an available item picks it up.
export const ITEM_PICKUP_RADIUS = 1.6;
// Radar power-up: the minimap reveals the enemy team for this long after use.
export const RADAR_DURATION_MS = 5_000;
// Cloak power-up: other players can't see your body for this long after use.
export const CLOAK_DURATION_MS = 4_000;

// One cell in this many carries an item; the rest stay empty. Keeps the floor
// sparse so a pickup is worth crossing the map for, rather than one underfoot
// in every cell. Deterministic in the seed (the keep gate draws from the same
// stream all clients run), so the thinned layout still agrees without a
// round-trip.
export const ITEM_SPAWN_KEEP_DENOM = 3;

// surge + radar are guaranteed every match; the rest are drawn from the seed.
export const ITEM_TYPES_ALWAYS: ItemType[] = ['surge', 'radar'];
export const ITEM_TYPES_ROTATING: ItemType[] = ['leap', 'portal', 'clone', 'overcharge', 'cloak'];

// Cells whose centers are excluded from the layout: both team spawns and the
// arena centroid. Items there would land on top of spawning players. Mirrors
// room.ts::teamSpawnCenter.
const EXCLUDED_CENTERS: Vec3[] = [
  { x: -12, y: 0, z: 4 },
  { x: 12, y: 0, z: 4 },
  { x: 0, y: 0, z: 0 },
];

interface GridGeom {
  cols: number;
  rows: number;
  cellX: number;
  cellZ: number;
  halfX: number;
  halfZ: number;
}

// Cell grid matching gridMaze.ts for each topology so item centers land in
// the middle of walkable cells.
function gridGeom(topology: Topology): GridGeom {
  if (topology === 'klein') {
    const cell = WORLD_WIDTH / GRID_MAZE_N;
    return {
      cols: 2 * GRID_MAZE_N,
      rows: GRID_MAZE_N,
      cellX: cell,
      cellZ: cell,
      halfX: WORLD_WIDTH,
      halfZ: WORLD_WIDTH / 2,
    };
  }
  if (topology === 'mobius') {
    const cols = 2 * GRID_MAZE_N;
    const rows = GRID_MAZE_N;
    return {
      cols,
      rows,
      cellX: (2 * MOBIUS_HALF_X) / cols,
      cellZ: (2 * MOBIUS_HALF_Z) / rows,
      halfX: MOBIUS_HALF_X,
      halfZ: MOBIUS_HALF_Z,
    };
  }
  // plane + torus share the square grid.
  const cell = WORLD_WIDTH / GRID_MAZE_N;
  return {
    cols: GRID_MAZE_N,
    rows: GRID_MAZE_N,
    cellX: cell,
    cellZ: cell,
    halfX: WORLD_WIDTH / 2,
    halfZ: WORLD_WIDTH / 2,
  };
}

function cellCenter(c: number, r: number, g: GridGeom): Vec3 {
  return { x: (c + 0.5) * g.cellX - g.halfX, y: 0, z: (r + 0.5) * g.cellZ - g.halfZ };
}

function cellIndexAt(pos: Vec3, g: GridGeom): number {
  let c = Math.floor((pos.x + g.halfX) / g.cellX);
  let r = Math.floor((pos.z + g.halfZ) / g.cellZ);
  c = Math.max(0, Math.min(g.cols - 1, c));
  r = Math.max(0, Math.min(g.rows - 1, r));
  return c + r * g.cols;
}

// Same 32-bit LCG the maze generator uses, wrapped as a stateful closure.
function lcg(seed: number): () => number {
  let rng = (seed | 0) >>> 0;
  return () => {
    rng = ((Math.imul(rng, 1664525) >>> 0) + 1013904223) >>> 0;
    return rng;
  };
}

/**
 * The set of item types in play this match: surge + radar always, plus 1-3
 * more drawn from the rotating pool, for 3-5 total. Deterministic in `seed`.
 */
export function rotateItemTypes(seed: number): ItemType[] {
  const next = lcg(seed);
  const pool = ITEM_TYPES_ROTATING.slice();
  // Fisher-Yates shuffle so the draw is unbiased and order-stable per seed.
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const extra = 1 + (next() % 3);
  return [...ITEM_TYPES_ALWAYS, ...pool.slice(0, extra)];
}

/**
 * One item per walkable cell (team-spawn + centroid cells excluded), with a
 * deterministic type drawn from the match rotation. Ids are stable `i-${cell}`
 * so the same seed/topology always yields the same item at the same id.
 */
export function itemSpawnLayout(
  seed: number,
  topology: Topology,
): Array<{ id: string; type: ItemType; position: Vec3 }> {
  const g = gridGeom(topology);
  const rotation = rotateItemTypes(seed);
  const excluded = new Set(EXCLUDED_CENTERS.map((p) => cellIndexAt(p, g)));
  const next = lcg(seed ^ 0x9e3779b9);
  const out: Array<{ id: string; type: ItemType; position: Vec3 }> = [];
  for (let r = 0; r < g.rows; r += 1) {
    for (let c = 0; c < g.cols; c += 1) {
      const cell = c + r * g.cols;
      if (excluded.has(cell)) continue;
      // Thin the field: only every ~KEEP_DENOM-th cell (seeded) keeps an item.
      if (next() % ITEM_SPAWN_KEEP_DENOM !== 0) continue;
      const type = rotation[next() % rotation.length]!;
      out.push({ id: `i-${cell}`, type, position: cellCenter(c, r, g) });
    }
  }
  return out;
}
