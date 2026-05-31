import { describe, expect, it } from 'vitest';
import type { ItemType, Topology } from './protocol.ts';
import {
  ITEM_SPAWN_KEEP_DENOM,
  ITEM_TYPES_ALWAYS,
  ITEM_TYPES_ROTATING,
  itemSpawnLayout,
  rotateItemTypes,
} from './items.ts';

const ALL_TYPES: ItemType[] = [...ITEM_TYPES_ALWAYS, ...ITEM_TYPES_ROTATING];
const TOPOLOGIES: Topology[] = ['plane', 'torus', 'mobius', 'klein'];

describe('rotateItemTypes', () => {
  it('always includes surge + radar', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const rotation = rotateItemTypes(seed * 7919 + 1);
      expect(rotation).toContain('surge');
      expect(rotation).toContain('radar');
    }
  });

  it('yields 3-5 distinct valid types', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const rotation = rotateItemTypes(seed * 104729 + 3);
      expect(rotation.length).toBeGreaterThanOrEqual(3);
      expect(rotation.length).toBeLessThanOrEqual(5);
      expect(new Set(rotation).size).toBe(rotation.length);
      for (const t of rotation) expect(ALL_TYPES).toContain(t);
    }
  });

  it('is deterministic in the seed', () => {
    expect(rotateItemTypes(12345)).toEqual(rotateItemTypes(12345));
  });
});

describe('itemSpawnLayout', () => {
  it('is deterministic for the same seed + topology', () => {
    for (const topology of TOPOLOGIES) {
      expect(itemSpawnLayout(42, topology)).toEqual(itemSpawnLayout(42, topology));
    }
  });

  it('only uses types from the match rotation', () => {
    const seed = 99;
    for (const topology of TOPOLOGIES) {
      const rotation = new Set(rotateItemTypes(seed));
      for (const item of itemSpawnLayout(seed, topology)) {
        expect(rotation.has(item.type)).toBe(true);
      }
    }
  });

  it('issues unique ids', () => {
    for (const topology of TOPOLOGIES) {
      const ids = itemSpawnLayout(7, topology).map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('excludes the team-spawn and centroid cells on the plane grid', () => {
    // plane: 10x10 cells, size 8, half 40. (-12,4) -> cell 53, (12,4) -> 56,
    // (0,0) -> 55. Those three cells must carry no item.
    const ids = new Set(itemSpawnLayout(123, 'plane').map((i) => i.id));
    expect(ids.has('i-53')).toBe(false);
    expect(ids.has('i-55')).toBe(false);
    expect(ids.has('i-56')).toBe(false);
  });

  it('thins the field to roughly one item per KEEP_DENOM walkable cells', () => {
    // 100 cells minus the 3 excluded = 97 walkable. The seeded keep gate leaves
    // ~1/KEEP_DENOM of them, so the count sits well below one-per-cell.
    const walkable = 97;
    const expected = walkable / ITEM_SPAWN_KEEP_DENOM;
    for (const seed of [1, 42, 123, 777, 9001]) {
      const count = itemSpawnLayout(seed, 'plane').length;
      expect(count).toBeLessThan(walkable);
      expect(count).toBeGreaterThan(expected * 0.5);
      expect(count).toBeLessThan(expected * 1.6);
    }
  });

  it('keeps every item inside the topology playfield', () => {
    for (const item of itemSpawnLayout(5, 'plane')) {
      expect(Math.abs(item.position.x)).toBeLessThanOrEqual(40);
      expect(Math.abs(item.position.z)).toBeLessThanOrEqual(40);
    }
  });
});
