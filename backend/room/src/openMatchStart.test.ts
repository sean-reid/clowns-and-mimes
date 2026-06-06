// Open-room auto-start: it must wait for a party to fully assemble before
// going live (so a party of 3-4 arriving a beat apart isn't split), with a
// hard-deadline escape hatch so a member who never connects can't hang the
// room. Drives the private gather helpers directly via the same `(room as any)`
// convention the simulate/matchStartSnapshot harnesses use.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { PlayerState } from '@cm/shared';
import { Room, type RoomEnv } from './room.ts';

function makeMockStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

function makeRoom(): Room {
  const state = {
    id: { toString: () => 'test-room-open' },
    acceptWebSocket: () => {},
    storage: makeMockStorage(),
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    getWebSockets: () => [],
  };
  const room = new Room(state as unknown as DurableObjectState, {} as RoomEnv);
  // Walls are seeded non-deterministically and can swallow the spawn point.
  (room as unknown as { walls: readonly unknown[] }).walls = [];
  return room;
}

function placeHuman(room: Room, id: string, partyId?: string, partySize?: number): void {
  const player: PlayerState = {
    id,
    name: id,
    team: 'mime',
    bot: false,
    position: { x: 0, y: 0.5, z: 0 },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  };
  (room as unknown as { players: Map<string, PlayerState> }).players.set(id, player);
  if (partyId) {
    (room as unknown as { partyIdByPlayer: Map<string, string> }).partyIdByPlayer.set(id, partyId);
    if (partySize) {
      (room as unknown as { expectedPartySize: Map<string, number> }).expectedPartySize.set(
        partyId,
        partySize,
      );
    }
  }
}

const phaseOf = (room: Room) => (room as unknown as { phase: string }).phase;
const setFilling = (room: Room) => ((room as unknown as { phase: string }).phase = 'filling');
const setDeadline = (room: Room, ms: number) =>
  ((room as unknown as { openGatherDeadline: number }).openGatherDeadline = ms);
const assembled = (room: Room) =>
  (room as unknown as { partiesAssembled(): boolean }).partiesAssembled();
const tryStart = (room: Room) =>
  (room as unknown as { startOpenMatchIfReady(): void }).startOpenMatchIfReady();
const clearTick = (room: Room) => {
  const h = (room as unknown as { tickHandle: ReturnType<typeof setInterval> | null }).tickHandle;
  if (h) clearInterval(h);
};

describe('open-room gather-aware auto-start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-06T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('does not start while a party is still arriving', () => {
    const room = makeRoom();
    setFilling(room);
    setDeadline(room, Date.now() + 12_000);
    placeHuman(room, 'a', 'P', 3);
    placeHuman(room, 'b', 'P', 3);
    expect(assembled(room)).toBe(false);
    tryStart(room);
    expect(phaseOf(room)).toBe('filling'); // held, not started
  });

  it('starts once the whole party has assembled', () => {
    const room = makeRoom();
    setFilling(room);
    setDeadline(room, Date.now() + 12_000);
    placeHuman(room, 'a', 'P', 3);
    placeHuman(room, 'b', 'P', 3);
    placeHuman(room, 'c', 'P', 3);
    expect(assembled(room)).toBe(true);
    tryStart(room);
    expect(phaseOf(room)).toBe('free_roam');
    clearTick(room);
  });

  it('starts past the hard deadline even if a party is short (no-show)', () => {
    const room = makeRoom();
    setFilling(room);
    setDeadline(room, Date.now() - 1); // deadline already elapsed
    placeHuman(room, 'a', 'P', 3);
    placeHuman(room, 'b', 'P', 3);
    expect(assembled(room)).toBe(true); // deadline overrides the short party
    tryStart(room);
    expect(phaseOf(room)).toBe('free_roam');
    clearTick(room);
  });

  it('treats solo players as always assembled', () => {
    const room = makeRoom();
    setFilling(room);
    setDeadline(room, Date.now() + 12_000);
    placeHuman(room, 'a');
    placeHuman(room, 'b');
    expect(assembled(room)).toBe(true);
  });
});
