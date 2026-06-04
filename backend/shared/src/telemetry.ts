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
  | { t: 'item_used'; itemType: string }
  | { t: 'projectile_hit'; distanceBucket: 'close' | 'medium' | 'far' };

export type TelemetryEventType = TelemetryEvent['t'];

export interface TelemetryEnvelope {
  events: TelemetryEvent[];
  telemetryId: string;
  clientVersion: string;
}
