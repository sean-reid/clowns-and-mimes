// Server-side grid pathfinder for bots. Walls in the labyrinth can sit between
// a bot and its chase / rescue target; the previous AI only tried the direct
// vector plus axis-aligned slides, so a wall between the two endpoints would
// pin the bot in place. This module exposes a BFS over the NxN cell grid that
// underlies the maze: an edge exists between two adjacent cells iff no wall
// segment crosses the line between their centers. `nextWaypoint` returns the
// world-space center of the next cell along the shortest path, which the bot
// can then aim at instead of the raw target.
//
// The graph is rebuilt whenever the wall set changes (seed or topology). BFS
// results are cached per (fromCell, toCell) for a short window so a swarm of
// bots all chasing the same target only pays the search cost once.

import type { Topology, Vec2 } from '@cm/shared';
import {
  nearestWallDistance,
  pathClearsWalls,
  pathCrossesWall,
  type WallSegment,
} from '@cm/shared/labyrinth';
import { GRID_MAZE_N, MOBIUS_GRID_X, MOBIUS_GRID_Z } from '@cm/shared/gridMaze';
import { MOBIUS_HALF_X, MOBIUS_HALF_Z } from '@cm/shared/mobius';
import { WORLD_WIDTH } from '@cm/shared/topology';
import {
  OCCUPANCY_RADIUS,
  OCCUPANCY_WEIGHT,
  WALL_AVOID_RADIUS,
  WALL_AVOID_WEIGHT,
} from '@cm/shared/botTuning';

// Linear repulsion ramp shared by the wall and player cost fields: full `weight`
// at the obstacle, falling to 0 at `radius` and beyond. Quantized to 1e-4 so the
// sqrt-based distance can never drift an A* tie between the TS and GDScript
// searches (both then store the same Float32). Distance beyond the radius -
// including Infinity when there's nothing to avoid - yields exactly 0.
function repulsion(distance: number, radius: number, weight: number): number {
  if (distance >= radius) return 0;
  return Math.round(weight * ((radius - distance) / radius) * 1e4) / 1e4;
}

interface GridShape {
  cols: number;
  rows: number;
  cellX: number;
  cellZ: number;
  wrapX: boolean;
  wrapZ: boolean;
  // Klein: when crossing the x seam, the row index flips. The wrap on the z
  // axis is plain modular. Torus does not flip.
  flipRowOnXWrap: boolean;
}

// Soft costs layered on the unit step cost so A* prefers a clearer route, not
// just any shortest one. Two continuous repulsion fields (see `repulsion`):
//
//  - walls (static, baked in computeWallCost): a cell's cost rises as its center
//    nears the closest wall or the playfield boundary, so paths hug the middle
//    of open lanes instead of scraping geometry, and
//  - players (dynamic, recomputed per query in aStarChain): a cell's cost rises
//    as its center nears any other player - teammates included - so bots route
//    around each other and a frozen body parked in a corridor instead of
//    stacking up. Soft, not a hard block, so a bot can still push through when
//    there's genuinely no other way; the destination cell is never penalized.
//
// Both fields read their weights/radii from @cm/shared/botTuning so the offline
// GDScript pathfinder runs the identical cost field.

export class BotPathfinder {
  private readonly shape: GridShape;
  // adjacency[cell] is a bitset over the cell's neighbor list. Bit k set means
  // the k-th neighbor entry is reachable. The neighbor lookup is by direction
  // index (east, north, west, south), so adjacency stores 4 bits per cell.
  private readonly adjacency: Uint8Array;
  // Per-cell static cost added when entering it: the continuous wall-repulsion
  // field (see computeWallCost). Precomputed from the walls, which don't move.
  private readonly wallCost: Float32Array;
  // A* cache: key is fromCell*total + toCell. Value is the cell chain from the
  // step after fromCell through toCell ([] if unreachable / same cell). Only
  // the no-occupancy search is cached (its cost field is static); the
  // occupancy-aware variant skips the cache since other players move each tick.
  private readonly chainCache = new Map<number, number[]>();
  // Walls kept for the line-of-sight funnel that smooths the cell path. A
  // segment between two points spanning more than this threshold has wrapped
  // around a seam, so the straight world line is meaningless and must not be
  // shortcut across (mirrors the seam handling in buildAdjacency).
  private readonly walls: readonly WallSegment[];
  private readonly seamThreshold: number;

  constructor(walls: readonly WallSegment[], topology: Topology) {
    this.shape = gridShapeFor(topology);
    const total = this.shape.cols * this.shape.rows;
    this.adjacency = new Uint8Array(total);
    this.wallCost = new Float32Array(total);
    this.walls = walls;
    this.seamThreshold = 2 * Math.max(this.shape.cellX, this.shape.cellZ);
    this.buildAdjacency(walls);
    this.computeWallCost();
  }

  /**
   * World-space point to walk toward, given current position `from` and the
   * desired destination `to`. Runs weighted A* over the cell grid, then
   * string-pulls the resulting cell path against line of sight so the bot aims
   * at the farthest waypoint it can see in a straight line instead of
   * stair-stepping cell center to cell center. Returns `to` unchanged when the
   * endpoints share a cell or no path exists (the caller's slide-fallback then
   * takes a stab at it).
   */
  nextWaypoint(from: Vec2, to: Vec2): Vec2 {
    const fromCell = this.worldToCell(from);
    const toCell = this.worldToCell(to);
    if (fromCell === toCell) return to;
    // Adjacent and reachable: head straight there, no search or funnel needed.
    if (this.directlyReachable(fromCell, toCell)) return to;
    return this.funnel(from, this.cachedChain(fromCell, toCell), to);
  }

  /**
   * Like nextWaypoint but layers a soft, distance-based cost around the given
   * player positions for this query, so the bot prefers to route around them
   * (other players - teammates included - and frozen bodies) yet can still pass
   * through if there's no real alternative. The destination cell is never
   * penalized. Skips the cache because the positions vary per tick.
   */
  nextWaypointAvoiding(from: Vec2, to: Vec2, avoidPositions: readonly Vec2[]): Vec2 {
    if (avoidPositions.length === 0) return this.nextWaypoint(from, to);
    const fromCell = this.worldToCell(from);
    const toCell = this.worldToCell(to);
    if (fromCell === toCell) return to;
    return this.funnel(from, this.aStarChain(fromCell, toCell, avoidPositions), to);
  }

  /** Public cell index for a world-space position; callers building an avoid
   * set query this for each other player. */
  cellAt(position: Vec2): number {
    return this.worldToCell(position);
  }

  /** World-space center of the cell containing `position`. Used as a gentle
   * unstuck target (snap toward the open cell center) in place of a teleport. */
  cellCenterOf(position: Vec2): Vec2 {
    return this.cellCenter(this.worldToCell(position));
  }

  // Cell chain from the step after fromCell through toCell, cached per
  // (from, to) pair for the no-occupancy common case (a swarm chasing one
  // target pays the search once). Empty when unreachable.
  private cachedChain(fromCell: number, toCell: number): number[] {
    const total = this.shape.cols * this.shape.rows;
    const key = fromCell * total + toCell;
    const cached = this.chainCache.get(key);
    if (cached !== undefined) return cached;
    const chain = this.aStarChain(fromCell, toCell);
    this.chainCache.set(key, chain);
    return chain;
  }

  // Weighted A* over the cell grid. Step cost into a cell is 1 + its static
  // wallCost, plus the dynamic player-repulsion cost when `avoidPositions` is
  // given (never on the destination cell). The heuristic is the wrap-aware cell
  // Manhattan distance, admissible because the minimum step cost is 1. Returns
  // the cells from the step after fromCell through toCell inclusive, or [] when
  // unreachable.
  private aStarChain(fromCell: number, toCell: number, avoidPositions?: readonly Vec2[]): number[] {
    const total = this.shape.cols * this.shape.rows;
    const occCost = avoidPositions ? this.occupancyCost(avoidPositions) : null;
    const g = new Float64Array(total).fill(Infinity);
    const came = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    g[fromCell] = 0;
    const open = new MinHeap();
    open.push(fromCell, this.cellHeuristic(fromCell, toCell));
    while (!open.isEmpty()) {
      const cur = open.pop();
      if (cur === toCell) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % this.shape.cols;
      const cr = Math.floor(cur / this.shape.cols);
      const mask = this.adjacency[cur]!;
      for (let dir = 0; dir < 4; dir += 1) {
        if ((mask & (1 << dir)) === 0) continue;
        const nb = this.neighborCell(cc, cr, dir);
        if (nb < 0 || closed[nb]) continue;
        let step = 1 + this.wallCost[nb]!;
        if (occCost && nb !== toCell) step += occCost[nb]!;
        const tentative = g[cur]! + step;
        if (tentative < g[nb]!) {
          g[nb] = tentative;
          came[nb] = cur;
          open.push(nb, tentative + this.cellHeuristic(nb, toCell));
        }
      }
    }
    if (g[toCell] === Infinity) return [];
    const rev: number[] = [];
    let cur = toCell;
    while (cur !== fromCell) {
      rev.push(cur);
      cur = came[cur]!;
    }
    rev.reverse();
    return rev;
  }

  // Wrap-aware cell Manhattan distance (minimum step count), used as the A*
  // heuristic. Underestimates true cost since every step costs at least 1.
  private cellHeuristic(a: number, b: number): number {
    const { cols, rows, wrapX, wrapZ } = this.shape;
    const ac = a % cols;
    const ar = Math.floor(a / cols);
    const bc = b % cols;
    const br = Math.floor(b / cols);
    let dc = Math.abs(ac - bc);
    if (wrapX) dc = Math.min(dc, cols - dc);
    let dr = Math.abs(ar - br);
    if (wrapZ) dr = Math.min(dr, rows - dr);
    return dc + dr;
  }

  // Static per-cell entry cost: a continuous repulsion field that rises as the
  // cell center nears the closest wall, ramping from 0 at WALL_AVOID_RADIUS to
  // WALL_AVOID_WEIGHT at the wall. The playfield boundary on a non-wrapping axis
  // counts as a wall, so edge cells get the same berth. Open cells cost ~0;
  // cells hugging walls/corners cost more, so A* leans toward clearance.
  private computeWallCost(): void {
    const { cols, rows, cellX, cellZ, wrapX, wrapZ } = this.shape;
    const total = cols * rows;
    const halfX = (cols * cellX) / 2;
    const halfZ = (rows * cellZ) / 2;
    for (let cell = 0; cell < total; cell += 1) {
      const c = this.cellCenter(cell);
      let d = nearestWallDistance(this.walls, c.x, c.z);
      if (!wrapX) d = Math.min(d, c.x + halfX, halfX - c.x);
      if (!wrapZ) d = Math.min(d, c.z + halfZ, halfZ - c.z);
      this.wallCost[cell] = repulsion(d, WALL_AVOID_RADIUS, WALL_AVOID_WEIGHT);
    }
  }

  // Dynamic per-cell entry cost for one query: a continuous repulsion field
  // around the avoid positions (other players), rising as a cell center nears
  // the closest one, ramping from 0 at OCCUPANCY_RADIUS to OCCUPANCY_WEIGHT at
  // the body. Recomputed per query since players move; the caller skips the
  // destination cell so a target standing in a crowd stays reachable.
  private occupancyCost(avoidPositions: readonly Vec2[]): Float64Array {
    const total = this.shape.cols * this.shape.rows;
    const out = new Float64Array(total);
    for (let cell = 0; cell < total; cell += 1) {
      const c = this.cellCenter(cell);
      let nearest = Infinity;
      for (const p of avoidPositions) {
        const d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d < nearest) nearest = d;
      }
      out[cell] = repulsion(nearest, OCCUPANCY_RADIUS, OCCUPANCY_WEIGHT);
    }
    return out;
  }

  // String-pull the cell chain against line of sight: walk the cell centers
  // (with the final cell replaced by the real `to`) and advance to the
  // farthest one reachable in a straight, wall-free line from `from`. Stop at
  // the first occluded waypoint, or at a seam crossing (a segment longer than
  // seamThreshold has wrapped, so its straight world line is meaningless - the
  // caller's wrap-aware aim still steers toward the near cell, then recomputes
  // after the bot crosses). Returns `to` when the chain is empty.
  private funnel(from: Vec2, chain: number[], to: Vec2): Vec2 {
    if (chain.length === 0) return to;
    const pts: Vec2[] = chain.map((c) => this.cellCenter(c));
    pts[pts.length - 1] = { x: to.x, z: to.z };
    let best = pts[0]!;
    let prev: Vec2 = from;
    for (let i = 0; i < pts.length; i += 1) {
      const c = pts[i]!;
      // A step between consecutive path points longer than seamThreshold has
      // wrapped a seam; raw line-of-sight past it is meaningless, so stop the
      // funnel here. The caller's wrap-aware aim steers toward the near cell,
      // then recomputes once the bot has crossed.
      if (
        Math.abs(c.x - prev.x) > this.seamThreshold ||
        Math.abs(c.z - prev.z) > this.seamThreshold
      )
        break;
      // Clearance-aware line of sight: only shortcut to a waypoint the bot's
      // body can reach in a straight line without scraping a wall. A plain
      // crossing test would accept a diagonal that skims a wall tip (the
      // center-to-center line never enters the wall), and the bot would then
      // pin on the corner because the movement layer enforces WALL_CLEARANCE.
      if (this.walls.length > 0 && !pathClearsWalls(this.walls, from.x, from.z, c.x, c.z)) break;
      best = c;
      prev = c;
    }
    return best;
  }

  private buildAdjacency(walls: readonly WallSegment[]): void {
    const { cols, rows } = this.shape;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cell = c + r * cols;
        let mask = 0;
        const { cellX, cellZ } = this.shape;
        const seamThreshold = 2 * Math.max(cellX, cellZ);
        for (let dir = 0; dir < 4; dir += 1) {
          const nb = this.neighborCell(c, r, dir);
          if (nb < 0) continue;
          const a = this.cellCenter(cell);
          const b = this.cellCenter(nb);
          // Seam-crossing neighbours have their wall check skipped: the
          // straight world line from a to b crosses the playfield
          // interior (the long way around the wrap) and would falsely
          // pick up walls between source and destination. Wrap seams
          // are open by definition.
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          if (Math.abs(dx) > seamThreshold || Math.abs(dz) > seamThreshold) {
            mask |= 1 << dir;
            continue;
          }
          if (!pathCrossesWall(walls, a.x, a.z, b.x, b.z)) {
            mask |= 1 << dir;
          }
        }
        this.adjacency[cell] = mask;
      }
    }
  }

  private directlyReachable(fromCell: number, toCell: number): boolean {
    const { cols } = this.shape;
    const cc = fromCell % cols;
    const cr = Math.floor(fromCell / cols);
    for (let dir = 0; dir < 4; dir += 1) {
      if ((this.adjacency[fromCell]! & (1 << dir)) === 0) continue;
      if (this.neighborCell(cc, cr, dir) === toCell) return true;
    }
    return false;
  }

  /**
   * Cell index of the cardinal neighbor of (col, row) in direction `dir`, or
   * -1 if the neighbor would fall outside a non-wrapping boundary. Wrap and
   * flip rules mirror gridMaze.neighborOf so the pathfinder agrees with the
   * maze generator about which faces are seams vs walls.
   *
   * dir: 0 east (+x), 1 north (+z), 2 west (-x), 3 south (-z)
   */
  private neighborCell(col: number, row: number, dir: number): number {
    const { cols, rows, wrapX, wrapZ, flipRowOnXWrap } = this.shape;
    let nc = col;
    let nr = row;
    let flipRow = false;
    if (dir === 0) nc = col + 1;
    else if (dir === 2) nc = col - 1;
    else if (dir === 1) nr = row + 1;
    else if (dir === 3) nr = row - 1;
    if (nc < 0 || nc >= cols) {
      if (!wrapX) return -1;
      nc = ((nc % cols) + cols) % cols;
      if (flipRowOnXWrap) flipRow = true;
    }
    if (nr < 0 || nr >= rows) {
      if (!wrapZ) return -1;
      nr = ((nr % rows) + rows) % rows;
    }
    if (flipRow) nr = rows - 1 - nr;
    return nc + nr * cols;
  }

  private worldToCell(p: Vec2): number {
    const { cols, rows, cellX, cellZ, wrapX, wrapZ } = this.shape;
    // Half-extents derived from the shape, not from WORLD_WIDTH: klein's
    // double cover spans 2*WORLD_WIDTH in x, so cellX*cols/2 is the correct
    // anchor for converting world coords back to cell indices.
    const halfX = (cols * cellX) / 2;
    const halfZ = (rows * cellZ) / 2;
    let c = Math.floor((p.x + halfX) / cellX);
    let r = Math.floor((p.z + halfZ) / cellZ);
    if (wrapX) c = ((c % cols) + cols) % cols;
    else c = Math.max(0, Math.min(cols - 1, c));
    if (wrapZ) r = ((r % rows) + rows) % rows;
    else r = Math.max(0, Math.min(rows - 1, r));
    return c + r * cols;
  }

  private cellCenter(cell: number): Vec2 {
    const { cols, rows, cellX, cellZ } = this.shape;
    const c = cell % cols;
    const r = Math.floor(cell / cols);
    const halfX = (cols * cellX) / 2;
    const halfZ = (rows * cellZ) / 2;
    return {
      x: (c + 0.5) * cellX - halfX,
      z: (r + 0.5) * cellZ - halfZ,
    };
  }
}

function gridShapeFor(topology: Topology): GridShape {
  if (topology === 'klein') {
    // Klein's playfield is the double cover: 2N x N cells over a 2W x W
    // domain. The maze generator places the z-mirror of the fundamental in
    // the right half of the grid; both halves agree on the openings at every
    // seam, so the pathfinder treats this as plain modular wrap in both
    // axes. The bottle's z-flip is in the geometry, not the wrap.
    return {
      cols: 2 * GRID_MAZE_N,
      rows: GRID_MAZE_N,
      cellX: WORLD_WIDTH / GRID_MAZE_N,
      cellZ: WORLD_WIDTH / GRID_MAZE_N,
      wrapX: true,
      wrapZ: true,
      flipRowOnXWrap: false,
    };
  }
  if (topology === 'mobius') {
    // Möbius strip cylindrical double cover. The right half of the maze
    // is the z-mirror of the left, so the wrap is plain modular x with
    // NO row flip - the flip is in the geometry, not in the wrap rule
    // (same trick Klein uses). z is hard-bounded by top/bottom walls.
    return {
      cols: MOBIUS_GRID_X,
      rows: MOBIUS_GRID_Z,
      cellX: (2 * MOBIUS_HALF_X) / MOBIUS_GRID_X,
      cellZ: (2 * MOBIUS_HALF_Z) / MOBIUS_GRID_Z,
      wrapX: true,
      wrapZ: false,
      flipRowOnXWrap: false,
    };
  }
  return {
    cols: GRID_MAZE_N,
    rows: GRID_MAZE_N,
    cellX: WORLD_WIDTH / GRID_MAZE_N,
    cellZ: WORLD_WIDTH / GRID_MAZE_N,
    wrapX: topology !== 'plane',
    wrapZ: topology !== 'plane',
    flipRowOnXWrap: false,
  };
}

// Minimal binary min-heap over (cell, priority) pairs for the A* open set.
// Lazy: a cell can be pushed more than once as its g-score improves; the search
// skips already-closed pops, so stale duplicates are harmless. Kept tiny and
// allocation-light because it ports straight across to the GDScript bot.
class MinHeap {
  private readonly cells: number[] = [];
  private readonly prio: number[] = [];

  isEmpty(): boolean {
    return this.cells.length === 0;
  }

  push(cell: number, priority: number): void {
    this.cells.push(cell);
    this.prio.push(priority);
    let i = this.cells.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent]! <= this.prio[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.cells[0]!;
    const lastCell = this.cells.pop()!;
    const lastPrio = this.prio.pop()!;
    if (this.cells.length > 0) {
      this.cells[0] = lastCell;
      this.prio[0] = lastPrio;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(i: number): void {
    const n = this.cells.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.prio[l]! < this.prio[smallest]!) smallest = l;
      if (r < n && this.prio[r]! < this.prio[smallest]!) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const c = this.cells[a]!;
    this.cells[a] = this.cells[b]!;
    this.cells[b] = c;
    const p = this.prio[a]!;
    this.prio[a] = this.prio[b]!;
    this.prio[b] = p;
  }
}
