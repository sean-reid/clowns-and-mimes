// Telemetry event payloads. Opt-in; sent from the client to the
// telemetry Worker, which writes them to KV for later aggregation.
// No PII. All identifiers are random UUIDs generated client-side and
// stored locally.

import type { Topology } from './protocol.ts';

export type TelemetryEvent =
  | { t: 'session_start'; v: string; platform: string; telemetryId: string }
  | { t: 'session_end'; durationS: number; matchCount: number }
  | {
      t: 'match_start';
      topology: Topology;
      mode: 'open' | 'private' | 'offline';
      partySize: number;
      botCount: number;
    }
  | { t: 'match_end'; durationS: number; outcome: 'won' | 'lost'; team: 'mime' | 'clown' }
  | { t: 'item_pickup'; itemType: string }
  | { t: 'projectile_hit'; distanceBucket: 'close' | 'medium' | 'far' }
  // Reliability + funnel signals (client-emitted).
  // The player left a live match before it ended (quit, drop, or reconnect
  // give-up); `phase` is where they bailed.
  | { t: 'match_abandoned'; durationS: number; phase: string }
  // Outcome of an online connection attempt. `reason` carries detail for
  // rejected (close code / error code) and the fallback trigger; '' otherwise.
  | { t: 'connect_result'; outcome: 'connected' | 'timeout_offline' | 'rejected'; reason: string }
  // The reconnect-grace ladder resolved: recovered, or gave up.
  | { t: 'reconnect'; outcome: 'success' | 'expired' }
  // Which path the player took out of the menu (app-open -> match funnel).
  | { t: 'menu_funnel'; action: 'open' | 'private' | 'offline' };

export type TelemetryEventType = TelemetryEvent['t'];

export interface TelemetryEnvelope {
  events: TelemetryEvent[];
  telemetryId: string;
  clientVersion: string;
}
