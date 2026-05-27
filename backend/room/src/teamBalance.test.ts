import { describe, expect, it } from 'vitest';
import { balanceTeamAssignments } from './teamBalance.ts';

const human = (id: string, team: 'mime' | 'clown') => ({ id, team, bot: false });
const bot = (id: string, team: 'mime' | 'clown') => ({ id, team, bot: true });

describe('balanceTeamAssignments', () => {
  it('returns an empty map when there is no one to rebalance', () => {
    expect(balanceTeamAssignments([])).toEqual(new Map());
    expect(balanceTeamAssignments([human('a', 'mime')])).toEqual(new Map());
  });

  it('splits four humans evenly even when they all joined the same team', () => {
    const players = [
      human('a', 'mime'),
      human('b', 'mime'),
      human('c', 'mime'),
      human('d', 'mime'),
    ];
    const result = balanceTeamAssignments(players);
    // Sort by id: a, b, c, d. Even indices -> mime, odd -> clown.
    // a/c already mime, no entry; b/d flip to clown.
    expect(result.get('a')).toBeUndefined();
    expect(result.get('b')).toBe('clown');
    expect(result.get('c')).toBeUndefined();
    expect(result.get('d')).toBe('clown');
    expect(result.size).toBe(2);
  });

  it('handles odd counts with one extra mime, never two of the same team in a row', () => {
    const players = [
      human('a', 'mime'),
      human('b', 'mime'),
      human('c', 'mime'),
      human('d', 'mime'),
      human('e', 'mime'),
    ];
    const result = balanceTeamAssignments(players);
    // Sorted a/b/c/d/e -> mime/clown/mime/clown/mime. Three mimes, two clowns.
    expect(result.get('b')).toBe('clown');
    expect(result.get('d')).toBe('clown');
    expect(result.size).toBe(2);
  });

  it('ignores bots when computing the split', () => {
    const players = [
      human('a', 'mime'),
      bot('z1', 'mime'),
      bot('z2', 'mime'),
      human('b', 'mime'),
      bot('z3', 'clown'),
      bot('z4', 'clown'),
    ];
    const result = balanceTeamAssignments(players);
    expect(result.get('b')).toBe('clown');
    expect(result.has('z1')).toBe(false);
    expect(result.has('z2')).toBe(false);
    expect(result.has('z3')).toBe(false);
    expect(result.has('z4')).toBe(false);
  });

  it('skips humans already on the correct team', () => {
    const players = [human('a', 'mime'), human('b', 'clown')];
    const result = balanceTeamAssignments(players);
    expect(result.size).toBe(0);
  });

  it('is deterministic for a given roster', () => {
    const players = [human('alpha', 'mime'), human('beta', 'mime'), human('gamma', 'mime')];
    const first = balanceTeamAssignments(players);
    const second = balanceTeamAssignments([...players].reverse());
    expect(first).toEqual(second);
  });
});
