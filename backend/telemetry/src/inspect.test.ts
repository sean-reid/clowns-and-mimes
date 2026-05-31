import { describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '@cm/shared';
import { bucketLabel, parseArgs, rollup } from './inspect.ts';

describe('parseArgs', () => {
  it('defaults to dev and today', () => {
    const args = parseArgs([]);
    expect(args.env).toBe('dev');
    expect(args.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args.type).toBeUndefined();
  });

  it('reads env, day, and type', () => {
    const args = parseArgs(['--env', 'production', '--day', '2026-05-30', '--type', 'item_used']);
    expect(args).toEqual({ env: 'production', day: '2026-05-30', type: 'item_used' });
  });
});

describe('bucketLabel', () => {
  it('buckets session_end by duration band', () => {
    expect(bucketLabel({ t: 'session_end', durationS: 30, matchCount: 1 })).toBe('<60s');
    expect(bucketLabel({ t: 'session_end', durationS: 120, matchCount: 2 })).toBe('60-300s');
    expect(bucketLabel({ t: 'session_end', durationS: 600, matchCount: 5 })).toBe('300s+');
  });

  it('labels match_start with topology, mode, party, and bots', () => {
    expect(
      bucketLabel({ t: 'match_start', topology: 'torus', mode: 'open', partySize: 2, botCount: 5 }),
    ).toBe('torus/open (party 2, bots 5)');
  });

  it('labels item events by itemType', () => {
    expect(bucketLabel({ t: 'item_pickup', itemType: 'leap' })).toBe('leap');
    expect(bucketLabel({ t: 'item_used', itemType: 'portal' })).toBe('portal');
  });
});

describe('rollup', () => {
  it('tallies events by their bucket label', () => {
    const events: TelemetryEvent[] = [
      { t: 'item_used', itemType: 'leap' },
      { t: 'item_used', itemType: 'leap' },
      { t: 'item_used', itemType: 'cloak' },
    ];
    const counts = rollup(events);
    expect(counts.get('leap')).toBe(2);
    expect(counts.get('cloak')).toBe(1);
    expect(counts.size).toBe(2);
  });
});
