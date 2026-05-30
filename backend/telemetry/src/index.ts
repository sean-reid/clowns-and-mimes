import type { TelemetryEnvelope, TelemetryEvent } from '@cm/shared';
import { makeKvStore } from './store.ts';

export interface Env {
  EVENTS: KVNamespace;
  ENV: string;
  RETENTION_DAYS: string;
}

const MAX_EVENTS_PER_REQUEST = 50;
// Loose validator: the envelope shape is the source of truth, but
// don't reject events on minor schema drift - the worker's job is to
// receive what the client sent, the dashboard can clean it up later.
const KNOWN_EVENT_TYPES = new Set([
  'session_start',
  'session_end',
  'match_start',
  'match_end',
  'item_pickup',
  'item_used',
  'projectile_hit',
]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json({ ok: true, env: env.ENV });
    }
    if (req.method === 'POST' && url.pathname === '/events') {
      return postEvents(req, env);
    }
    return new Response('not found', { status: 404 });
  },
};

async function postEvents(req: Request, env: Env): Promise<Response> {
  let body: TelemetryEnvelope;
  try {
    body = (await req.json()) as TelemetryEnvelope;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!Array.isArray(body.events) || typeof body.telemetryId !== 'string') {
    return json({ error: 'invalid_envelope' }, 400);
  }
  if (body.events.length > MAX_EVENTS_PER_REQUEST) {
    return json({ error: 'too_many_events' }, 413);
  }
  const events = body.events.filter(isPlausibleEvent);
  const retention = parsePositiveInt(env.RETENTION_DAYS, 30);
  const store = makeKvStore(env.EVENTS, retention);
  const written = await store.append(events, new Date());
  return json({ ok: true, written });
}

function isPlausibleEvent(e: unknown): e is TelemetryEvent {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { t?: unknown }).t === 'string' &&
    KNOWN_EVENT_TYPES.has((e as { t: string }).t)
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
