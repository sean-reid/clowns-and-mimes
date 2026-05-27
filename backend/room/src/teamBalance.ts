import type { Team } from '@cm/shared';

/**
 * Compute team reassignments to even out the human roster across the
 * two teams. Bots are ignored; the bot fill that follows match-start
 * will refill any holes the reassignment leaves behind.
 *
 * Sort by id (UUIDs are random) and alternate, so the assignment is
 * deterministic across re-runs of the same roster but effectively
 * random across rooms. Returns only the entries that need to change,
 * so the caller can avoid unnecessary spawn-position resets.
 */
export function balanceTeamAssignments(
  players: ReadonlyArray<{ id: string; team: Team; bot: boolean }>,
): Map<string, Team> {
  const humans = players.filter((p) => !p.bot);
  const reassignments = new Map<string, Team>();
  if (humans.length < 2) return reassignments;
  const sorted = [...humans].sort((a, b) => a.id.localeCompare(b.id));
  sorted.forEach((p, i) => {
    const team: Team = i % 2 === 0 ? 'mime' : 'clown';
    if (p.team !== team) reassignments.set(p.id, team);
  });
  return reassignments;
}
