import { describe, expect, it } from 'vitest';
import { balanceTeamAssignments } from './teamBalance.ts';

const human = (id: string, team: 'mime' | 'clown') => ({ id, team, bot: false });
const bot = (id: string, team: 'mime' | 'clown') => ({ id, team, bot: true });

// Matches the room's TEAM_TARGET; the bot fill tops each team up to this.
const TARGET = 4;

describe('balanceTeamAssignments', () => {
  it('returns an empty map when there is no one to rebalance', () => {
    expect(balanceTeamAssignments([], TARGET)).toEqual(new Map());
    expect(balanceTeamAssignments([human('a', 'mime')], TARGET)).toEqual(new Map());
  });

  it('keeps a 2-person party together - the bot fill makes the teams even', () => {
    // Both joined `mime` via their party preferTeam. mime=2 <= TARGET, so the
    // fill (2 bots on mime, 4 on clown) evens it out without splitting them.
    const result = balanceTeamAssignments([human('a', 'mime'), human('b', 'mime')], TARGET);
    expect(result.size).toBe(0);
  });

  it('leaves a full team of humans alone when the fill can still balance it', () => {
    const players = [
      human('a', 'mime'),
      human('b', 'mime'),
      human('c', 'mime'),
      human('d', 'mime'),
    ];
    // mime=4 == TARGET; clown fills to 4 bots. Even, so nobody moves.
    expect(balanceTeamAssignments(players, TARGET).size).toBe(0);
  });

  it('sheds only the overflow when a team exceeds capacity', () => {
    const players = [
      human('a', 'mime'),
      human('b', 'mime'),
      human('c', 'mime'),
      human('d', 'mime'),
      human('e', 'mime'),
    ];
    // mime=5 > TARGET: move exactly one (lowest id) to clown -> 4 vs 1, then
    // bots fill clown to 4. Everyone else keeps their team.
    const result = balanceTeamAssignments(players, TARGET);
    expect(result.size).toBe(1);
    expect(result.get('a')).toBe('clown');
  });

  it('rebalances the heavy team in the reported 5-clown / 3-mime case', () => {
    const players = [
      human('m1', 'mime'),
      human('m2', 'mime'),
      human('m3', 'mime'),
      human('c1', 'clown'),
      human('c2', 'clown'),
      human('c3', 'clown'),
      human('c4', 'clown'),
      human('c5', 'clown'),
    ];
    // 8 humans, cap = max(4, 4) = 4. clown=5 sheds one -> 4 mime / 4 clown.
    const result = balanceTeamAssignments(players, TARGET);
    expect(result.size).toBe(1);
    expect(result.get('c1')).toBe('mime');
  });

  it('splits evenly when humans outnumber two full teams', () => {
    const players = Array.from({ length: 10 }, (_, i) => human(`h${i}`, 'mime'));
    // 10 humans, cap = max(4, 5) = 5. mime=10 sheds 5 -> 5 vs 5.
    const result = balanceTeamAssignments(players, TARGET);
    expect(result.size).toBe(5);
    for (const team of result.values()) expect(team).toBe('clown');
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
    // Only 2 humans, both mime <= TARGET: no human moves, bots untouched.
    const result = balanceTeamAssignments(players, TARGET);
    expect(result.size).toBe(0);
  });

  it('leaves an already-even roster untouched', () => {
    const players = [human('a', 'mime'), human('b', 'clown')];
    expect(balanceTeamAssignments(players, TARGET).size).toBe(0);
  });

  it('is deterministic for a given roster', () => {
    const players = Array.from({ length: 5 }, (_, i) => human(`p${i}`, 'mime'));
    const first = balanceTeamAssignments(players, TARGET);
    const second = balanceTeamAssignments([...players].reverse(), TARGET);
    expect(first).toEqual(second);
  });
});
