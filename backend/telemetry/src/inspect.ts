// Read-only inspector for the telemetry KV store. The Worker is
// write-only (POST /events), so this is the admin path to see what
// landed: it shells out to `wrangler kv` against the EVENTS binding,
// then rolls up a day's events by type with a per-type breakdown.
//
//   pnpm --filter @cm/telemetry inspect                # today, dev
//   pnpm --filter @cm/telemetry inspect --env production
//   pnpm --filter @cm/telemetry inspect --day 2026-05-30 --type item_used
//
// Runs `wrangler` from node_modules/.bin (on PATH under pnpm), reading
// the binding + namespace id from wrangler.toml, so it needs the same
// Cloudflare auth a deploy would.

import { execFileSync } from 'node:child_process';
import type { TelemetryEvent, TelemetryEventType } from '@cm/shared';

export interface Args {
  env: 'dev' | 'production';
  day: string;
  type?: TelemetryEventType;
}

const KEY_PREFIX = 'tel';

export function parseArgs(argv: string[]): Args {
  const args: Args = { env: 'dev', day: utcToday() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--env':
        if (value !== 'dev' && value !== 'production') fail(`--env must be dev or production`);
        args.env = value;
        i++;
        break;
      case '--day':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) fail(`--day must be YYYY-MM-DD`);
        args.day = value;
        i++;
        break;
      case '--type':
        if (!value) fail(`--type needs a value`);
        args.type = value as TelemetryEventType;
        i++;
        break;
      default:
        fail(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function fail(msg: string): never {
  console.error(`[inspect] ${msg}`);
  process.exit(2);
}

// The breakdown key a single event contributes to. Pure so the
// aggregation is unit-testable without touching KV.
export function bucketLabel(ev: TelemetryEvent): string {
  switch (ev.t) {
    case 'session_start':
      return `${ev.platform} v${ev.v}`;
    case 'session_end':
      return ev.durationS < 60 ? '<60s' : ev.durationS < 300 ? '60-300s' : '300s+';
    case 'match_start':
      return `${ev.topology}/${ev.mode} (party ${ev.partySize}, bots ${ev.botCount})`;
    case 'match_end':
      return `${ev.outcome} as ${ev.team}`;
    case 'item_pickup':
    case 'item_used':
      return ev.itemType;
    case 'projectile_hit':
      return ev.distanceBucket;
  }
}

export function rollup(events: TelemetryEvent[]): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const ev of events) {
    const label = bucketLabel(ev);
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }
  return buckets;
}

// Wrangler prepends a human-readable banner (update notices, the
// "agent skills" nag) to stdout, so the payload isn't the whole
// string. Slice from the first JSON delimiter to its matching last
// one and parse that.
export function parseWranglerJson<T>(raw: string): T {
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  if (start === -1 || end < start) {
    throw new Error(`no JSON in wrangler output: ${raw.slice(0, 120).trim()}`);
  }
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

// Wrangler emits its banner on stderr and the payload on stdout, so we
// only read stdout. `--remote` is required or it hits the local store.
function wrangler(args: string[], env: Args['env']): string {
  return execFileSync('wrangler', [...args, '--binding', 'EVENTS', '--env', env, '--remote'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function listKeys(env: Args['env'], day: string): string[] {
  const raw = wrangler(['kv', 'key', 'list', '--prefix', `${KEY_PREFIX}:${day}:`], env);
  const parsed = parseWranglerJson<Array<{ name: string }>>(raw);
  return parsed.map((k) => k.name).sort();
}

function getEvents(env: Args['env'], key: string): TelemetryEvent[] {
  let raw: string;
  try {
    raw = wrangler(['kv', 'key', 'get', key], env);
  } catch {
    // Key expired between list and get, or never existed. Treat as empty.
    return [];
  }
  try {
    const parsed = parseWranglerJson<unknown>(raw);
    return Array.isArray(parsed) ? (parsed as TelemetryEvent[]) : [];
  } catch {
    console.error(`[inspect] skipping ${key}: value is not JSON`);
    return [];
  }
}

function printBuckets(buckets: Map<string, number>): void {
  for (const [label, n] of [...buckets].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(28)} ${n}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[inspect] env=${args.env} day=${args.day}${args.type ? ` type=${args.type}` : ''}`);

  const keys = listKeys(args.env, args.day).filter(
    (k) => !args.type || k === `${KEY_PREFIX}:${args.day}:${args.type}`,
  );
  if (keys.length === 0) {
    console.log('[inspect] no events for that day');
    return;
  }

  const perType = new Map<TelemetryEventType, TelemetryEvent[]>();
  let total = 0;
  for (const key of keys) {
    const type = key.split(':')[2] as TelemetryEventType;
    const events = getEvents(args.env, key);
    perType.set(type, events);
    total += events.length;
  }

  console.log(`[inspect] ${total} events across ${perType.size} type(s)\n`);
  for (const [type, events] of [...perType].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${type}: ${events.length}`);
    printBuckets(rollup(events));
  }
}

// Only run when invoked as a script, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
