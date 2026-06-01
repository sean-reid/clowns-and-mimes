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
import { pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';
import { GRID_MAZE_N, MOBIUS_GRID_X, MOBIUS_GRID_Z } from '@cm/shared/gridMaze';
import { MOBIUS_HALF_X, MOBIUS_HALF_Z } from '@cm/shared/mobius';
import { WORLD_WIDTH } from '@cm/shared/topology';

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

export class BotPathfinder {
  private readonly shape: GridShape;
  // adjacency[cell] is a bitset over the cell's neighbor list. Bit k set means
  // the k-th neighbor entry is reachable. The neighbor lookup is by direction
  // index (east, north, west, south), so adjacency stores 4 bits per cell.
  private readonly adjacency: Uint8Array;
  // BFS cache: key is fromCell*total + toCell. Value is the cell chain from the
  // step after fromCell through toCell ([] if unreachable / same cell). The map
  // is fresh per pathfinder; bots typically query a handful of cell pairs per
  // tick so it stays small. The avoiding variant skips the cache (its forbidden
  // set varies per tick).
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
    this.walls = walls;
    this.seamThreshold = 2 * Math.max(this.shape.cellX, this.shape.cellZ);
    this.buildAdjacency(walls);
  }

  /**
   * World-space point to walk toward, given current position `from` and the
   * desired destination `to`. Runs BFS over the cell grid, then string-pulls
   * the resulting cell path against line of sight so the bot aims at the
   * farthest waypoint it can see in a straight line instead of stair-stepping
   * cell center to cell center. Returns `to` unchanged when the endpoints
   * share a cell or no path exists (the caller's slide-fallback then takes a
   * stab at it).
   */
  nextWaypoint(from: Vec2, to: Vec2): Vec2 {
    const fromCell = this.worldToCell(from);
    const toCell = this.worldToCell(to);
    if (fromCell === toCell) return to;
    // Adjacent and reachable: head straight there, no BFS or funnel needed.
    if (this.directlyReachable(fromCell, toCell)) return to;
    return this.funnel(from, this.cachedChain(fromCell, toCell), to);
  }

  /**
   * Like nextWaypoint but treats the given cells as solid for this query.
   * Used by the chase / rescue path so a frozen enemy parked in the corridor
   * routes around instead of pinning the bot against the body. The avoid set
   * must not include the destination cell (toCell is allowed). Skips the BFS
   * cache because the avoid set varies per tick.
   */
  nextWaypointAvoiding(from: Vec2, to: Vec2, avoidCells: ReadonlySet<number>): Vec2 {
    if (avoidCells.size === 0) return this.nextWaypoint(from, to);
    const fromCell = this.worldToCell(from);
    const toCell = this.worldToCell(to);
    if (fromCell === toCell) return to;
    return this.funnel(from, this.bfsChain(fromCell, toCell, avoidCells), to);
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
  // (from, to) pair for the no-avoid common case (a swarm chasing one target
  // pays the search once). Empty when unreachable.
  private cachedChain(fromCell: number, toCell: number): number[] {
    const total = this.shape.cols * this.shape.rows;
    const key = fromCell * total + toCell;
    const cached = this.chainCache.get(key);
    if (cached !== undefined) return cached;
    const chain = this.bfsChain(fromCell, toCell);
    this.chainCache.set(key, chain);
    return chain;
  }

  // BFS shortest path over the cell grid. Returns the cells from the step
  // after fromCell through toCell inclusive, or [] when unreachable. `avoid`
  // cells are solid for this query unless they are the destination.
  private bfsChain(fromCell: number, toCell: number, avoid?: ReadonlySet<number>): number[] {
    const total = this.shape.cols * this.shape.rows;
    const parent = new Int32Array(total);
    parent.fill(-1);
    parent[fromCell] = fromCell;
    const queue: number[] = [fromCell];
    let found = false;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === toCell) {
        found = true;
        break;
      }
      const cc = cur % this.shape.cols;
      const cr = Math.floor(cur / this.shape.cols);
      const mask = this.adjacency[cur]!;
      for (let dir = 0; dir < 4; dir += 1) {
        if ((mask & (1 << dir)) === 0) continue;
        const nb = this.neighborCell(cc, cr, dir);
        if (nb < 0) continue;
        if (parent[nb] !== -1) continue;
        if (avoid && nb !== toCell && avoid.has(nb)) continue;
        parent[nb] = cur;
        queue.push(nb);
      }
    }
    if (!found) return [];
    const rev: number[] = [];
    let cur = toCell;
    while (cur !== fromCell) {
      rev.push(cur);
      cur = parent[cur]!;
    }
    rev.reverse();
    return rev;
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
      if (this.walls.length > 0 && pathCrossesWall(this.walls, from.x, from.z, c.x, c.z)) break;
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
