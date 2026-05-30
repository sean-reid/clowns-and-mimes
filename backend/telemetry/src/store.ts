import type { TelemetryEvent } from '@cm/shared';

const KEY_PREFIX = 'tel';

/** YYYY-MM-DD in UTC. Buckets events by day for downstream aggregation. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Storage key for a (day, event-type) pair. Append-only. */
export function eventKey(day: string, type: string): string {
  return `${KEY_PREFIX}:${day}:${type}`;
}

export interface EventStore {
  append(events: TelemetryEvent[], now: Date): Promise<number>;
}

export function makeKvStore(kv: KVNamespace, retentionDays: number): EventStore {
  return {
    async append(events, now) {
      if (events.length === 0) return 0;
      const day = dayKey(now);
      // Group by event type so a daily aggregation job can hit one
      // key per type per day. Each key stores an array of payloads
      // that grows over the day, then gets reduced and pruned.
      const byType = new Map<string, TelemetryEvent[]>();
      for (const ev of events) {
        const list = byType.get(ev.t) ?? [];
        list.push(ev);
        byType.set(ev.t, list);
      }
      let written = 0;
      for (const [type, batch] of byType) {
        const key = eventKey(day, type);
        const existing = (await kv.get<TelemetryEvent[]>(key, 'json')) ?? [];
        existing.push(...batch);
        // expirationTtl drops the key automatically; we re-set it on
        // every write so the day's value lives `retentionDays` past
        // the *last* event, not the first.
        await kv.put(key, JSON.stringify(existing), {
          expirationTtl: retentionDays * 24 * 60 * 60,
        });
        written += batch.length;
      }
      return written;
    },
  };
}
