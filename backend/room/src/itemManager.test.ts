import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState, ServerToClient, Team, Topology, Vec3 } from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import { ITEM_RESPAWN_MS } from '@cm/shared/items';
import { SURGE_DURATION_MS } from '@cm/shared/movement';
import { PORTAL_DURATION_MS } from '@cm/shared/portals';
import { ItemManager, type ItemManagerHost } from './itemManager.ts';

function makePlayer(
  id: string,
  team: Team,
  pos: Vec3,
  over: Partial<PlayerState> = {},
): PlayerState {
  return {
    id,
    name: id,
    team,
    bot: false,
    position: pos,
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
    ...over,
  };
}

interface Harness {
  im: ItemManager;
  players: Map<string, PlayerState>;
  connections: Map<WebSocket, { playerId: string }>;
  broadcasts: ServerToClient[];
}

function harness(seed = 1, topology: Topology = 'plane', walls: WallSegment[] = []): Harness {
  const players = new Map<string, PlayerState>();
  const connections = new Map<WebSocket, { playerId: string }>();
  const broadcasts: ServerToClient[] = [];
  const host: ItemManagerHost = {
    players,
    connections,
    worldWidth: 80,
    getTopology: () => topology,
    getSeed: () => seed,
    getWalls: () => walls,
    broadcast: (msg) => broadcasts.push(msg),
  };
  return { im: new ItemManager(host), players, connections, broadcasts };
}

function kinds(broadcasts: ServerToClient[]): string[] {
  return broadcasts.map((m) => (m as { kind?: { kind: string } }).kind?.kind ?? '');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ItemManager.spawn', () => {
  it('populates the floor from the deterministic layout', () => {
    const h = harness();
    h.im.spawn();
    expect(h.im.available().length).toBeGreaterThan(0);
  });
});

describe('ItemManager.step pickup', () => {
  it('a player on an item picks it up and it leaves the floor', () => {
    const h = harness();
    h.im.spawn();
    const target = h.im.available()[0]!;
    h.players.set('p', makePlayer('p', 'mime', { ...target.position }));
    h.im.step(1 / 60);
    const p = h.players.get('p')!;
    expect(p.activeItem).toBe(target.type);
    expect(kinds(h.broadcasts)).toContain('item_pickup');
    expect(h.im.available().some((i) => i.id === target.id)).toBe(false);
  });

  it('does not pick up while already holding (no stacking)', () => {
    const h = harness();
    h.im.spawn();
    const target = h.im.available()[0]!;
    h.players.set('p', makePlayer('p', 'mime', { ...target.position }, { activeItem: 'surge' }));
    h.im.step(1 / 60);
    expect(kinds(h.broadcasts)).not.toContain('item_pickup');
    expect(h.im.available().some((i) => i.id === target.id)).toBe(true);
  });

  it('a frozen player cannot pick up', () => {
    const h = harness();
    h.im.spawn();
    const target = h.im.available()[0]!;
    h.players.set('p', makePlayer('p', 'mime', { ...target.position }, { frozen: true }));
    h.im.step(1 / 60);
    expect(kinds(h.broadcasts)).not.toContain('item_pickup');
  });
});

describe('ItemManager.step respawn', () => {
  it('respawns the item after ITEM_RESPAWN_MS and broadcasts item_spawn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = harness();
    h.im.spawn();
    const target = h.im.available()[0]!;
    h.players.set('p', makePlayer('p', 'mime', { ...target.position }));
    h.im.step(1 / 60);
    expect(h.im.available().some((i) => i.id === target.id)).toBe(false);
    // Move the player off so the respawned item isn't grabbed again.
    h.players.get('p')!.position = { x: 1000, y: 0, z: 1000 };
    vi.setSystemTime(ITEM_RESPAWN_MS + 1);
    h.im.step(1 / 60);
    expect(kinds(h.broadcasts)).toContain('item_spawn');
    expect(h.im.available().some((i) => i.id === target.id)).toBe(true);
  });
});

describe('ItemManager.onUseItem', () => {
  it('clears the held item and broadcasts item_used', () => {
    const h = harness();
    const ws = {} as WebSocket;
    h.players.set('p', makePlayer('p', 'mime', { x: 0, y: 0, z: 0 }, { activeItem: 'leap' }));
    h.connections.set(ws, { playerId: 'p' });
    h.im.onUseItem(ws);
    expect(h.players.get('p')!.activeItem).toBeUndefined();
    expect(h.broadcasts).toEqual([
      { t: 'event', kind: { kind: 'item_used', playerId: 'p', itemType: 'leap' } },
    ]);
  });

  it('is a no-op when the player holds nothing', () => {
    const h = harness();
    const ws = {} as WebSocket;
    h.players.set('p', makePlayer('p', 'mime', { x: 0, y: 0, z: 0 }));
    h.connections.set(ws, { playerId: 'p' });
    h.im.onUseItem(ws);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('arms the next jump when a leap is used', () => {
    const h = harness();
    const ws = {} as WebSocket;
    h.players.set('p', makePlayer('p', 'mime', { x: 0, y: 0, z: 0 }, { activeItem: 'leap' }));
    h.connections.set(ws, { playerId: 'p' });
    h.im.onUseItem(ws);
    expect(h.players.get('p')!.leapArmed).toBe(true);
  });

  it('does not arm a leap when a different item is used', () => {
    const h = harness();
    const ws = {} as WebSocket;
    h.players.set('p', makePlayer('p', 'mime', { x: 0, y: 0, z: 0 }, { activeItem: 'surge' }));
    h.connections.set(ws, { playerId: 'p' });
    h.im.onUseItem(ws);
    expect(h.players.get('p')!.leapArmed).toBeUndefined();
  });

  it('sets a surge deadline when a surge is used', () => {
    const h = harness();
    const ws = {} as WebSocket;
    h.players.set('p', makePlayer('p', 'mime', { x: 0, y: 0, z: 0 }, { activeItem: 'surge' }));
    h.connections.set(ws, { playerId: 'p' });
    const before = Date.now();
    h.im.onUseItem(ws);
    const surgeUntil = h.players.get('p')!.surgeUntil ?? 0;
    expect(surgeUntil).toBeGreaterThanOrEqual(before + SURGE_DURATION_MS);
    expect(surgeUntil).toBeLessThanOrEqual(Date.now() + SURGE_DURATION_MS);
  });
});

describe('ItemManager portal', () => {
  // One wall the player at the origin (yaw 0 -> facing -z) hits, plus a second
  // elsewhere so the exit lands on a different wall.
  const PORTAL_WALLS = [
    { ax: -2, az: -3, bx: 2, bz: -3 },
    { ax: -2, az: 10, bx: 2, bz: 10 },
  ];

  function openPortalFor(z: number): Harness {
    const h = harness(1, 'plane', PORTAL_WALLS);
    const ws = {} as WebSocket;
    h.players.set('p', makePlayer('p', 'mime', { x: 0, y: 0, z }, { activeItem: 'portal' }));
    h.connections.set(ws, { playerId: 'p' });
    h.im.onUseItem(ws);
    return h;
  }

  it('opens a wall-anchored pair on use and broadcasts portal_open', () => {
    const h = openPortalFor(-2);
    expect(kinds(h.broadcasts)).toContain('portal_open');
    expect(h.im.activePortals()).toHaveLength(1);
    const portal = h.im.activePortals()[0]!;
    // Entry mouth lands on the faced wall (z=-3); exit on the other wall (z=10).
    expect(portal.a.z).toBeCloseTo(-3, 6);
    expect(portal.b.z).toBeCloseTo(10, 6);
  });

  it('is a no-op pair when there are no walls but still clears the slot', () => {
    const h = harness(1, 'plane', []);
    const ws = {} as WebSocket;
    h.players.set('p', makePlayer('p', 'mime', { x: 0, y: 0, z: 0 }, { activeItem: 'portal' }));
    h.connections.set(ws, { playerId: 'p' });
    h.im.onUseItem(ws);
    expect(h.players.get('p')!.activeItem).toBeUndefined();
    expect(kinds(h.broadcasts)).toContain('item_used');
    expect(kinds(h.broadcasts)).not.toContain('portal_open');
    expect(h.im.activePortals()).toHaveLength(0);
  });

  it('teleports a player who walks into a mouth to the opposite side', () => {
    const h = openPortalFor(-2);
    // A second player stands on the exit mouth (z=10) and steps through.
    h.players.set('q', makePlayer('q', 'clown', { x: 0, y: 0, z: 10 }));
    h.im.step(1 / 60);
    // Emerges off the entry wall into the open cell, well away from z=10.
    expect(h.players.get('q')!.position.z).toBeLessThan(0);
  });

  it('does not teleport the opener while they stand on the entry mouth', () => {
    const h = openPortalFor(-2);
    h.im.step(1 / 60);
    expect(h.players.get('p')!.position).toEqual({ x: 0, y: 0, z: -2 });
  });

  it('closes the pair after PORTAL_DURATION_MS and broadcasts portal_close', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = openPortalFor(-2);
    expect(h.im.activePortals()).toHaveLength(1);
    vi.setSystemTime(PORTAL_DURATION_MS + 1);
    h.im.step(1 / 60);
    expect(kinds(h.broadcasts)).toContain('portal_close');
    expect(h.im.activePortals()).toHaveLength(0);
  });
});
