import { describe, expect, it } from 'vitest';
import type { Team } from '@cm/shared';
import { balanceTeamAssignments } from './teamBalance.ts';

const human = (id: string, team: Team, partyId?: string) => ({ id, team, bot: false, partyId });
const bot = (id: string, team: Team) => ({ id, team, bot: true });

// Matches the room's TEAM_TARGET; the bot fill tops each team up to this.
const TARGET = 4;

// Apply a reassignment map to a roster and return the resulting human counts.
function teamsAfter(
  players: ReadonlyArray<{ id: string; team: Team; bot: boolean }>,
  moves: Map<string, Team>,
): { mime: number; clown: number } {
  const counts = { mime: 0, clown: 0 };
  for (const p of players) {
    if (p.bot) continue;
    counts[moves.get(p.id) ?? p.team] += 1;
  }
  return counts;
}

describe('balanceTeamAssignments', () => {
  it('returns an empty map when there is no one to rebalance', () => {
    expect(balanceTeamAssignments([], TARGET)).toEqual(new Map());
    expect(balanceTeamAssignments([human('a', 'mime')], TARGET)).toEqual(new Map());
  });

  it('keeps a party together rather than splitting it to balance', () => {
    // Both joined `mime` as one party. mime=2 humans; the bot fill evens the
    // teams (2 bots on mime, 4 on clown), so nobody is moved.
    const players = [human('a', 'mime', 'p1'), human('b', 'mime', 'p1')];
    expect(balanceTeamAssignments(players, TARGET).size).toBe(0);
  });

  it('keeps a full party of four together (bots fill the other side)', () => {
    const players = [
      human('a', 'mime', 'p1'),
      human('b', 'mime', 'p1'),
      human('c', 'mime', 'p1'),
      human('d', 'mime', 'p1'),
    ];
    expect(balanceTeamAssignments(players, TARGET).size).toBe(0);
  });

  it('reunites a party that was split across teams', () => {
    // 3 of 4 already on mime -> the whole party consolidates onto mime.
    const players = [
      human('a', 'mime', 'p1'),
      human('b', 'mime', 'p1'),
      human('c', 'mime', 'p1'),
      human('d', 'clown', 'p1'),
    ];
    const result = balanceTeamAssignments(players, TARGET);
    expect(result.get('d')).toBe('mime');
    expect(result.size).toBe(1);
  });

  it('balances solo players onto even teams', () => {
    // Solos are not a party, so they split to even the match.
    const players = [human('a', 'mime'), human('b', 'mime'), human('c', 'mime'), human('d', 'mime')];
    const counts = teamsAfter(players, balanceTeamAssignments(players, TARGET));
    expect(counts).toEqual({ mime: 2, clown: 2 });
  });

  it('evens the reported 5-clown / 3-mime roster of solos', () => {
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
    const result = balanceTeamAssignments(players, TARGET);
    expect(result.size).toBe(1);
    expect(teamsAfter(players, result)).toEqual({ mime: 4, clown: 4 });
  });

  it('keeps a party intact while balancing the solos around it', () => {
    // A party of 3 plus 2 solos, all on mime. The party stays one team; the
    // result is within one of even and the party is never split.
    const players = [
      human('p1a', 'mime', 'P'),
      human('p1b', 'mime', 'P'),
      human('p1c', 'mime', 'P'),
      human('s1', 'mime'),
      human('s2', 'mime'),
    ];
    const result = balanceTeamAssignments(players, TARGET);
    const finalTeam = (id: string, t: Team) => result.get(id) ?? t;
    const party = [finalTeam('p1a', 'mime'), finalTeam('p1b', 'mime'), finalTeam('p1c', 'mime')];
    expect(new Set(party).size).toBe(1); // party all on one team
    const counts = teamsAfter(players, result);
    expect(Math.abs(counts.mime - counts.clown)).toBeLessThanOrEqual(1);
  });

  it('never splits two parties and seats them on opposite sides', () => {
    const players = [
      human('a', 'mime', 'A'),
      human('b', 'mime', 'A'),
      human('c', 'mime', 'A'),
      human('d', 'mime', 'A'),
      human('e', 'mime', 'B'),
      human('f', 'mime', 'B'),
      human('g', 'mime', 'B'),
      human('h', 'mime', 'B'),
    ];
    const result = balanceTeamAssignments(players, TARGET);
    const finalTeam = (id: string) => result.get(id) ?? 'mime';
    // Each party lands wholly on one team, and the two parties are on opposite
    // teams -> a clean 4-4.
    expect(new Set(['a', 'b', 'c', 'd'].map(finalTeam)).size).toBe(1);
    expect(new Set(['e', 'f', 'g', 'h'].map(finalTeam)).size).toBe(1);
    expect(teamsAfter(players, result)).toEqual({ mime: 4, clown: 4 });
  });

  it('ignores bots when computing the split', () => {
    const players = [
      human('a', 'mime', 'p1'),
      bot('z1', 'mime'),
      human('b', 'mime', 'p1'),
      bot('z2', 'clown'),
    ];
    const result = balanceTeamAssignments(players, TARGET);
    expect(result.has('z1')).toBe(false);
    expect(result.has('z2')).toBe(false);
    // The 2-person party stays together; bots aren't counted or moved.
    expect(result.size).toBe(0);
  });

  it('leaves an already-even roster untouched', () => {
    const players = [human('a', 'mime'), human('b', 'clown')];
    expect(balanceTeamAssignments(players, TARGET).size).toBe(0);
  });

  it('is deterministic for a given roster', () => {
    const players = [
      human('p0', 'mime'),
      human('p1', 'mime'),
      human('p2', 'mime'),
      human('p3', 'mime'),
      human('p4', 'mime'),
    ];
    const first = balanceTeamAssignments(players, TARGET);
    const second = balanceTeamAssignments([...players].reverse(), TARGET);
    expect(first).toEqual(second);
  });
});
