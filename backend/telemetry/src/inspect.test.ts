import { describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '@cm/shared';
import { bucketLabel, parseArgs, parseWranglerJson, rollup } from './inspect.ts';

describe('parseArgs', () => {
  it('defaults to dev and today', () => {
    const args = parseArgs([]);
    expect(args.env).toBe('dev');
    expect(args.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args.type).toBeUndefined();
  });

  it('reads env, day, and type', () => {
    const args = parseArgs(['--env', 'production', '--day', '2026-05-30', '--type', 'item_pickup']);
    expect(args).toEqual({ env: 'production', day: '2026-05-30', type: 'item_pickup' });
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

  it('labels item_pickup by itemType', () => {
    expect(bucketLabel({ t: 'item_pickup', itemType: 'leap' })).toBe('leap');
  });

  it('labels projectile_hit by distance bucket', () => {
    expect(bucketLabel({ t: 'projectile_hit', distanceBucket: 'close' })).toBe('close');
  });

  it('labels match_abandoned by phase', () => {
    expect(bucketLabel({ t: 'match_abandoned', durationS: 42, phase: 'turn_mime' })).toBe(
      'phase turn_mime',
    );
  });

  it('labels connect_result by outcome, with the reason for rejections', () => {
    expect(bucketLabel({ t: 'connect_result', outcome: 'connected', reason: '' })).toBe(
      'connected',
    );
    expect(
      bucketLabel({ t: 'connect_result', outcome: 'timeout_offline', reason: 'network timed out' }),
    ).toBe('timeout_offline');
    expect(
      bucketLabel({ t: 'connect_result', outcome: 'rejected', reason: 'version_mismatch' }),
    ).toBe('rejected: version_mismatch');
  });

  it('labels reconnect and menu_funnel by their outcome/action', () => {
    expect(bucketLabel({ t: 'reconnect', outcome: 'success' })).toBe('success');
    expect(bucketLabel({ t: 'menu_funnel', action: 'open' })).toBe('open');
  });

  it('falls back gracefully for a retired event type still in KV', () => {
    // item_used was dropped from the schema, but old events linger until TTL;
    // the inspector must label them rather than crash on the unmatched case.
    expect(bucketLabel({ t: 'item_used', itemType: 'radar' } as unknown as TelemetryEvent)).toBe(
      'radar',
    );
    expect(bucketLabel({ t: 'mystery' } as unknown as TelemetryEvent)).toBe('mystery');
  });
});

describe('parseWranglerJson', () => {
  it('parses an array after a wrangler banner on stdout', () => {
    const raw =
      'Cloudflare agent skills are available for: Claude Code. Run wrangler ...\n' +
      '[{"name":"tel:2026-05-31:item_pickup"}]';
    expect(parseWranglerJson<Array<{ name: string }>>(raw)).toEqual([
      { name: 'tel:2026-05-31:item_pickup' },
    ]);
  });

  it('parses clean JSON with no banner', () => {
    expect(parseWranglerJson<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('throws when there is no JSON', () => {
    expect(() => parseWranglerJson('not json at all')).toThrow(/no JSON/);
  });
});

describe('rollup', () => {
  it('tallies events by their bucket label', () => {
    const events: TelemetryEvent[] = [
      { t: 'item_pickup', itemType: 'leap' },
      { t: 'item_pickup', itemType: 'leap' },
      { t: 'item_pickup', itemType: 'cloak' },
    ];
    const counts = rollup(events);
    expect(counts.get('leap')).toBe(2);
    expect(counts.get('cloak')).toBe(1);
    expect(counts.size).toBe(2);
  });
});
