import type { Team } from '@cm/shared';

interface BalancePlayer {
  id: string;
  team: Team;
  bot: boolean;
  // Party the human belongs to, if any. Members of one party are an atomic
  // unit: they always land wholly on the same team.
  partyId?: string;
}

interface Unit {
  ids: string[];
  team: Team;
}

/**
 * Compute the minimum team reassignments so the match starts even, WITHOUT ever
 * splitting a party. Bots are ignored; the bot fill that follows match start
 * tops each team up to `teamTarget`.
 *
 * Humans are grouped into atomic units - one per party (by partyId), one per
 * solo. A party lands wholly on the team most of its members already hold (so a
 * party that joined together stays put, and a party that a prior balance split
 * is reunited). We then move whole units from the heavier side to the lighter
 * until the human counts are within one, preferring the move that closes the gap
 * fastest; a unit too big to help (a full party on an already-even split) stays
 * put. The party cap equals `teamTarget`, so a party never outgrows one team and
 * an even split is always reachable.
 *
 * Returns only the entries that change, so the caller can skip spawn-position
 * resets for everyone staying put. Deterministic for a given roster.
 */
export function balanceTeamAssignments(
  players: ReadonlyArray<BalancePlayer>,
  teamTarget: number,
): Map<string, Team> {
  const humans = players.filter((p) => !p.bot);
  const result = new Map<string, Team>();
  if (humans.length < 2) return result;

  const parties = new Map<string, { id: string; team: Team }[]>();
  const units: Unit[] = [];
  for (const p of humans) {
    if (p.partyId !== undefined) {
      const arr = parties.get(p.partyId) ?? [];
      arr.push({ id: p.id, team: p.team });
      parties.set(p.partyId, arr);
    } else {
      units.push({ ids: [p.id], team: p.team });
    }
  }
  // Each party becomes one unit on the team most of its members already hold;
  // ties break to mime. This keeps a still-grouped party where it joined and
  // consolidates a previously-split one.
  for (const members of parties.values()) {
    const mimeCount = members.filter((m) => m.team === 'mime').length;
    const team: Team = mimeCount * 2 >= members.length ? 'mime' : 'clown';
    units.push({ ids: members.map((m) => m.id), team });
  }

  const cap = Math.max(teamTarget, Math.ceil(humans.length / 2));
  const sizeOn = (t: Team): number =>
    units.reduce((n, u) => (u.team === t ? n + u.ids.length : n), 0);

  // Move whole units heavy -> light until balanced. Each move strictly shrinks
  // the gap (we only take a move whose post-move gap is smaller), so this
  // terminates; when no unit can improve the gap, we stop.
  for (;;) {
    const mime = sizeOn('mime');
    const clown = sizeOn('clown');
    const gap = Math.abs(mime - clown);
    if (gap <= 1 && mime <= cap && clown <= cap) break;
    const heavy: Team = mime > clown ? 'mime' : 'clown';
    // Among units on the heavy side, take the one that leaves the smallest gap
    // (moving size s turns gap into |gap - 2s|). Tie-break: smaller unit first
    // (fewer players uprooted), then lowest id for determinism.
    const candidates = units
      .filter((u) => u.team === heavy)
      .sort((a, b) => a.ids.length - b.ids.length || a.ids[0]!.localeCompare(b.ids[0]!));
    let best: Unit | null = null;
    let bestGap = gap;
    for (const u of candidates) {
      const newGap = Math.abs(gap - 2 * u.ids.length);
      if (newGap < bestGap) {
        bestGap = newGap;
        best = u;
      }
    }
    if (best === null) break;
    best.team = heavy === 'mime' ? 'clown' : 'mime';
  }

  const original = new Map(humans.map((p) => [p.id, p.team]));
  for (const u of units) {
    for (const id of u.ids) {
      if (original.get(id) !== u.team) result.set(id, u.team);
    }
  }
  return result;
}
