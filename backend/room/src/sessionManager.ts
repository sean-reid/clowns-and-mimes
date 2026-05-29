// Session token + disconnect-grace bookkeeping extracted from room.ts
// under Phase B3 of the file-split plan. Owns the two Maps that drive
// reconnect: sessionTokens (playerId -> opaque resumption secret) and
// disconnectTimers (playerId -> pending finalize timeout).
//
// Self-contained: no host interface needed. Room invokes the lifecycle
// methods directly and supplies its finalize callback when scheduling
// the grace window. Reconnect-grace bugs (the "ladder loses race vs
// finalize" class) localize here.

/**
 * Window during which a player whose WS has closed can reconnect with
 * their sessionToken and resume the same PlayerState. Bots keep playing
 * against them in absentia; their input queue stays empty so their body
 * stands still (and is vulnerable to tags) until the WS is back. After
 * the window expires their PlayerState is torn down for real and the
 * usual humans-zero match-state cleanup runs.
 *
 * 45 s is sized to outrun the worst-case client reconnect ladder. The
 * arena schedules 3 attempts with backoffs [0.5, 1.5, 3.0] and each
 * step waits `wait_s + 1` for the connection result, so the ladder
 * itself can take ~13 s. The disconnect also takes a moment to surface
 * on the client (TCP retries, Godot's STATE_CLOSED detection). 15 s
 * left only ~2 s of margin and lost the race in the wild: finalize
 * ran first, the player slot was nuked, and the reconnect arrived as
 * a fresh join in a bot-empty room.
 */
export const RECONNECT_GRACE_MS = 45_000;

export class SessionManager {
  // Per-player resumption secrets. Handed to the client in their snapshot
  // and presented back on the next join so a transient WS drop is
  // resumed against the same PlayerState (team, position, frozen) rather
  // than spawning fresh.
  private readonly sessionTokens = new Map<string, string>();

  // Pending finalize timeouts. While an entry is present the player is
  // in the session-token grace window: their PlayerState stays in
  // Room.players, the tick keeps running, and bots keep playing against
  // the now-stationary body. If a resume arrives the entry is cleared;
  // otherwise the timeout fires and the supplied callback runs the real
  // teardown.
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Wall-clock ms at which each pending grace window is scheduled to
  // fire. Mirrored alongside the timer handle so RoomPersistence can
  // serialize the in-flight graces and resume them with the correct
  // remaining time after a DO restart. Cleared in cancelFinalize /
  // forget alongside the timer.
  private readonly disconnectExpiresAt = new Map<string, number>();

  /** Mint a fresh session token for a player and return it. */
  mint(playerId: string): string {
    const token = crypto.randomUUID();
    this.sessionTokens.set(playerId, token);
    return token;
  }

  /**
   * Re-install a token a previous DO instance had already minted for
   * `playerId`. Used by RoomPersistence on construct to restore tokens
   * across a wrangler-deploy DO restart so the client's existing
   * sessionToken still resolves on the next join.
   */
  restore(playerId: string, token: string): void {
    this.sessionTokens.set(playerId, token);
  }

  /** Look up the current token for a player. Empty string when missing. */
  tokenFor(playerId: string): string {
    return this.sessionTokens.get(playerId) ?? '';
  }

  /**
   * Token -> playerId reverse lookup. Caller is expected to also
   * verify the playerId still exists in Room.players before resuming.
   */
  resumePlayerId(sessionToken: string): string | null {
    for (const [id, token] of this.sessionTokens) {
      if (token === sessionToken) return id;
    }
    return null;
  }

  /**
   * Start the grace window for `playerId`. After `delayMs` (default
   * `RECONNECT_GRACE_MS`) with no resume, the supplied `onFinalize`
   * callback fires and the caller does the real teardown. Idempotent:
   * replacing an in-flight timer clears the previous one first. The
   * `delayMs` override exists for RoomPersistence restore, which resumes
   * a grace window with the time remaining rather than the full 45 s.
   */
  scheduleFinalize(playerId: string, onFinalize: () => void, delayMs = RECONNECT_GRACE_MS): void {
    const existing = this.disconnectTimers.get(playerId);
    if (existing !== undefined) clearTimeout(existing);
    this.disconnectExpiresAt.set(playerId, Date.now() + delayMs);
    this.disconnectTimers.set(
      playerId,
      setTimeout(() => {
        this.disconnectTimers.delete(playerId);
        this.disconnectExpiresAt.delete(playerId);
        onFinalize();
      }, delayMs),
    );
  }

  /** Cancel any pending finalize for `playerId`. No-op when none scheduled. */
  cancelFinalize(playerId: string): void {
    const existing = this.disconnectTimers.get(playerId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.disconnectTimers.delete(playerId);
      this.disconnectExpiresAt.delete(playerId);
    }
  }

  /**
   * Tear down all session state for `playerId`. Called by Room after the
   * grace window expires (the timer callback already removed itself from
   * the disconnectTimers map at that point; the call here is a safety
   * net for paths that bypass the timer).
   */
  forget(playerId: string): void {
    this.sessionTokens.delete(playerId);
    this.cancelFinalize(playerId);
  }

  /**
   * Number of players currently in the grace window. Room.activeHumans
   * subtracts this from the human roster size so the tick-pauses-while-
   * no-active-humans logic counts grace-window players as inactive.
   */
  pendingDisconnectCount(): number {
    return this.disconnectTimers.size;
  }

  /** Snapshot of [playerId, token] pairs for RoomPersistence serialization. */
  exportSessions(): Array<[string, string]> {
    return Array.from(this.sessionTokens.entries());
  }

  /**
   * Snapshot of [playerId, graceExpiresAtMs] pairs for RoomPersistence
   * serialization. Restore re-arms timers with `expiresAt - Date.now()`
   * as the remaining delay.
   */
  exportPendingDisconnects(): Array<[string, number]> {
    return Array.from(this.disconnectExpiresAt.entries());
  }
}
