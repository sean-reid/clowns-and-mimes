import type { Team } from '@cm/shared';

/**
 * Compute the minimum team reassignments so the match starts even. Players keep
 * the team they joined with unless their team is over capacity - which is what
 * keeps a party together, since every party member joins with the same
 * preferTeam. Bots are ignored; the bot fill that follows match start tops each
 * team up to `teamTarget`, so any split where both teams hold no more than
 * `teamTarget` humans already ends up even and needs no human moved at all.
 *
 * We only move humans off a team that exceeds the per-team cap. The cap is
 * `teamTarget` normally, and rises to an even share (`ceil(humans / 2)`) once
 * humans outnumber two full teams, so both sides stay equal in that case too.
 * When a team must shed, its lowest-id members move first, so the result is
 * deterministic across re-runs of the same roster.
 *
 * Returns only the entries that change, so the caller can skip spawn-position
 * resets for everyone staying put.
 */
export function balanceTeamAssignments(
  players: ReadonlyArray<{ id: string; team: Team; bot: boolean }>,
  teamTarget: number,
): Map<string, Team> {
  const humans = players.filter((p) => !p.bot);
  const reassignments = new Map<string, Team>();
  if (humans.length < 2) return reassignments;
  const cap = Math.max(teamTarget, Math.ceil(humans.length / 2));
  const byTeam: Record<Team, string[]> = { mime: [], clown: [] };
  for (const p of humans) byTeam[p.team].push(p.id);
  const pairs: [Team, Team][] = [
    ['mime', 'clown'],
    ['clown', 'mime'],
  ];
  for (const [team, other] of pairs) {
    const ids = byTeam[team];
    if (ids.length <= cap) continue;
    const excess = ids.length - cap;
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < excess; i += 1) reassignments.set(sorted[i]!, other);
  }
  return reassignments;
}
