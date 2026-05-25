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
import { GENUS2_GRID_N, GRID_MAZE_N } from '@cm/shared/gridMaze';
import { pointInOctagon, stepAcrossGenus2Boundary } from '@cm/shared/genus2';
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
  // Genus2: instead of plain modular wrap on the bounding box, a neighbor
  // step that would leave the octagonal playfield is routed through the
  // octagon's side identification (rotation + translation). Set true only
  // for the double-torus topology.
  octagonSeams: boolean;
}

export class BotPathfinder {
  private readonly shape: GridShape;
  // adjacency[cell] is a bitset over the cell's neighbor list. Bit k set means
  // the k-th neighbor entry is reachable. The neighbor lookup is by direction
  // index (east, north, west, south), so adjacency stores 4 bits per cell.
  private readonly adjacency: Uint8Array;
  // BFS cache: key is fromCell*total + toCell. Value is the first cell to walk
  // toward (-1 if none / unreachable / same cell). The map is cleared whenever
  // a new pathfinder is constructed; bots typically query a handful of cell
  // pairs per tick so the map stays small.
  private readonly nextStepCache = new Map<number, number>();

  constructor(walls: readonly WallSegment[], topology: Topology) {
    this.shape = gridShapeFor(topology);
    const total = this.shape.cols * this.shape.rows;
    this.adjacency = new Uint8Array(total);
    this.buildAdjacency(walls);
  }

  /**
   * World-space center of the next cell to walk toward, given current position
   * `from` and the desired destination `to`. Returns `to` unchanged when the
   * two endpoints are in the same cell or in adjacent reachable cells (no
   * detour needed). Returns `to` unchanged when no path exists - the caller
   * still gets the original target so the existing slide-fallback in
   * simulateBots can take a stab at it.
   */
  nextWaypoint(from: Vec2, to: Vec2): Vec2 {
    const fromCell = this.worldToCell(from);
    const toCell = this.worldToCell(to);
    if (fromCell === toCell) return to;
    // If the destination cell is a direct neighbor of the start, no BFS is
    // needed: just head straight there. The caller's slide-fallback handles
    // the final approach into the target's actual position.
    if (this.directlyReachable(fromCell, toCell)) return to;
    const nextCell = this.nextStepOnPath(fromCell, toCell);
    if (nextCell < 0) return to;
    return this.cellCenter(nextCell);
  }

  /**
   * Like nextWaypoint but treats the given cells as solid for this query.
   * Used by the chase / rescue path so a frozen enemy parked in the corridor
   * routes around instead of pinning the bot against the body. The avoid set
   * must not include the destination cell (toCell is allowed) or the bot's
   * own current cell (those are short-circuited above). Skips the BFS cache
   * because the avoid set varies per tick.
   */
  nextWaypointAvoiding(from: Vec2, to: Vec2, avoidCells: ReadonlySet<number>): Vec2 {
    if (avoidCells.size === 0) return this.nextWaypoint(from, to);
    const fromCell = this.worldToCell(from);
    const toCell = this.worldToCell(to);
    if (fromCell === toCell) return to;
    const nextCell = this.nextStepOnPathAvoiding(fromCell, toCell, avoidCells);
    if (nextCell < 0) return to;
    return this.cellCenter(nextCell);
  }

  /** Public cell index for a world-space position; callers building an avoid
   * set query this for each other player. */
  cellAt(position: Vec2): number {
    return this.worldToCell(position);
  }

  private nextStepOnPathAvoiding(
    fromCell: number,
    toCell: number,
    avoid: ReadonlySet<number>,
  ): number {
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
        // Forbidden cells are walkable destinations only when they ARE the
        // destination; otherwise the BFS treats them as solid.
        if (nb !== toCell && avoid.has(nb)) continue;
        parent[nb] = cur;
        queue.push(nb);
      }
    }
    if (!found) return -1;
    let cur = toCell;
    while (parent[cur] !== fromCell && parent[cur] !== cur) {
      cur = parent[cur]!;
    }
    return cur;
  }

  private buildAdjacency(walls: readonly WallSegment[]): void {
    const { cols, rows, octagonSeams } = this.shape;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cell = c + r * cols;
        // Genus-2: cells whose centres sit outside the octagon are not
        // walkable; they get no outgoing edges (and no other cell will
        // reach them either since the inverse step also lands outside).
        const a = this.cellCenter(cell);
        if (octagonSeams && !pointInOctagon(a)) {
          this.adjacency[cell] = 0;
          continue;
        }
        let mask = 0;
        for (let dir = 0; dir < 4; dir += 1) {
          const nb = this.neighborCell(c, r, dir);
          if (nb < 0) continue;
          const b = this.cellCenter(nb);
          // On genus-2, a step that crosses an octagon side is a seam
          // crossing: the source and destination cells are far apart in
          // world coords, and the boundary itself is open (no walls).
          // Detect seam crossings by distance: a regular grid step stays
          // within one cell's worth of motion, so anything past 2 cells
          // is a seam (or pathological).
          if (octagonSeams) {
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const maxStep = this.shape.cellX * 2;
            if (Math.abs(dx) > maxStep || Math.abs(dz) > maxStep) {
              // Seam crossing: skip the straight-line wall check (it
              // would falsely find walls between the source and the
              // wrapped destination on the far side of the polygon).
              mask |= 1 << dir;
              continue;
            }
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
   * BFS from `fromCell` to `toCell`, returning the first cell on the shortest
   * path (i.e. the immediate next step after `fromCell`). -1 if unreachable.
   * Cached per (from, to) pair.
   */
  private nextStepOnPath(fromCell: number, toCell: number): number {
    const total = this.shape.cols * this.shape.rows;
    const key = fromCell * total + toCell;
    const cached = this.nextStepCache.get(key);
    if (cached !== undefined) return cached;

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
        parent[nb] = cur;
        queue.push(nb);
      }
    }

    let step = -1;
    if (found) {
      // Walk parent pointers back from `toCell` until the predecessor is the
      // start; that predecessor's child is the first step on the path.
      let cur = toCell;
      while (parent[cur] !== fromCell && parent[cur] !== cur) {
        cur = parent[cur]!;
      }
      step = cur;
    }
    this.nextStepCache.set(key, step);
    return step;
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
    const { cols, rows, wrapX, wrapZ, flipRowOnXWrap, octagonSeams } = this.shape;
    let nc = col;
    let nr = row;
    let flipRow = false;
    if (dir === 0) nc = col + 1;
    else if (dir === 2) nc = col - 1;
    else if (dir === 1) nr = row + 1;
    else if (dir === 3) nr = row - 1;
    if (octagonSeams) {
      // Genus-2: the playfield is the octagon, not the bounding box. A
      // step whose neighbour cell centre falls outside the octagon routes
      // through the side identification (stepAcrossGenus2Boundary).
      const fromCenter = this.cellCenter(col + row * cols);
      const naive = this.naiveNeighborCenter(nc, nr);
      if (naive === null) {
        // The naive cell is outside the bounding box too; fall through
        // to the side identification using the step vector's direction.
      } else if (pointInOctagon(naive)) {
        // Plain in-polygon step.
        return nc + nr * cols;
      }
      const wrapped = stepAcrossGenus2Boundary(
        fromCenter,
        naive ?? this.stepCenter(fromCenter, dir),
      );
      return this.worldPointToCell(wrapped);
    }
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

  /**
   * World-coords centre of the (nc, nr) cell if the indices are in-range,
   * or null otherwise. Used by the octagon-seam neighbour path so we can
   * decide whether to apply the side identification.
   */
  private naiveNeighborCenter(nc: number, nr: number): Vec2 | null {
    const { cols, rows, cellX, cellZ } = this.shape;
    if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return null;
    const halfX = (cols * cellX) / 2;
    const halfZ = (rows * cellZ) / 2;
    return {
      x: (nc + 0.5) * cellX - halfX,
      z: (nr + 0.5) * cellZ - halfZ,
    };
  }

  /**
   * Position one cell-step in the given direction from `from`. Used when
   * the neighbour indices fell off the grid entirely (e.g., col=-1) so we
   * still have a valid `next` to hand to stepAcrossGenus2Boundary.
   */
  private stepCenter(from: Vec2, dir: number): Vec2 {
    const { cellX, cellZ } = this.shape;
    let dx = 0;
    let dz = 0;
    if (dir === 0) dx = cellX;
    else if (dir === 2) dx = -cellX;
    else if (dir === 1) dz = cellZ;
    else if (dir === 3) dz = -cellZ;
    return { x: from.x + dx, z: from.z + dz };
  }

  /**
   * Cell index containing a world-coords point. Identical to worldToCell
   * but exposed for the seam-crossing path which feeds in a non-grid
   * destination from stepAcrossGenus2Boundary.
   */
  private worldPointToCell(p: Vec2): number {
    return this.worldToCell(p);
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
      octagonSeams: false,
    };
  }
  if (topology === 'genus2') {
    // Octagonal playfield bounded by [-R, R] x [-R, R] (R = WORLD_WIDTH/2).
    // GENUS2_GRID_N x GENUS2_GRID_N cells inscribed in the bounding box.
    // Cells whose centres fall outside the polygon are non-walkable.
    // octagonSeams = true tells neighborCell to route an out-of-polygon
    // step through stepAcrossGenus2Boundary instead of plain modular
    // wrap, so a bot's BFS legitimately crosses an octagon side and lands
    // on the cell its mate side delivers it onto.
    return {
      cols: GENUS2_GRID_N,
      rows: GENUS2_GRID_N,
      cellX: WORLD_WIDTH / GENUS2_GRID_N,
      cellZ: WORLD_WIDTH / GENUS2_GRID_N,
      wrapX: false,
      wrapZ: false,
      flipRowOnXWrap: false,
      octagonSeams: true,
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
    octagonSeams: false,
  };
}
