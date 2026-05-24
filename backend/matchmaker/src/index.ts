import type {
  MatchmakeCreateBody,
  MatchmakeCreateResponse,
  MatchmakeJoinResponse,
  Topology,
} from '@cm/shared';

export interface Env {
  LOBBY_CODES: KVNamespace;
  ROOM_WORKER: string;
  WORKERS_SUBDOMAIN: string;
  ENV: string;
}

const VALID_TOPOLOGIES: readonly Topology[] = ['plane', 'torus', 'klein', 'sphere'];
const CODE_LENGTH = 6;
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const OPEN_ROOM_TTL_S = 60 * 30;
const PRIVATE_ROOM_TTL_S = 60 * 60 * 6;
const OPEN_ROOM_PREFIX = 'open:';
const OPEN_ROOM_SOFT_CAPACITY = 12;

interface OpenRoomEntry {
  roomId: string;
  topology: Topology;
  joined: number;
  createdAt: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json({ ok: true, env: env.ENV });
    }
    if (req.method === 'POST' && url.pathname === '/lobby') {
      return createPrivateLobby(req, env);
    }
    const joinMatch = url.pathname.match(/^\/lobby\/([A-Z0-9]+)\/join$/);
    if (req.method === 'POST' && joinMatch) {
      return joinByCode(joinMatch[1]!, env);
    }
    if (req.method === 'POST' && url.pathname === '/open/join') {
      return joinOpenRoom(env);
    }
    return notFound();
  },
};

async function createPrivateLobby(req: Request, env: Env): Promise<Response> {
  let body: MatchmakeCreateBody;
  try {
    body = (await req.json()) as MatchmakeCreateBody;
  } catch {
    return error(400, 'invalid_json');
  }
  if (!VALID_TOPOLOGIES.includes(body.topology)) {
    return error(400, 'invalid_topology');
  }
  const code = await freshCode(env);
  const roomId = crypto.randomUUID();
  await env.LOBBY_CODES.put(
    code,
    JSON.stringify({ roomId, topology: body.topology, createdAt: Date.now() }),
    { expirationTtl: PRIVATE_ROOM_TTL_S },
  );
  const res: MatchmakeCreateResponse = {
    code,
    roomId,
    wsUrl: wsUrlFor(env, roomId, body.topology),
  };
  return json(res);
}

async function joinByCode(code: string, env: Env): Promise<Response> {
  const raw = await env.LOBBY_CODES.get(code);
  if (!raw) return error(404, 'room_not_found');
  const parsed = JSON.parse(raw) as { roomId: string; topology: Topology };
  const res: MatchmakeJoinResponse = {
    roomId: parsed.roomId,
    wsUrl: wsUrlFor(env, parsed.roomId, parsed.topology),
  };
  return json(res);
}

async function joinOpenRoom(env: Env): Promise<Response> {
  const reusable = await findReusableOpenRoom(env);
  if (reusable !== null) {
    return json<MatchmakeJoinResponse>({
      roomId: reusable.roomId,
      wsUrl: wsUrlFor(env, reusable.roomId, reusable.topology),
    });
  }
  const topology = VALID_TOPOLOGIES[Math.floor(Math.random() * VALID_TOPOLOGIES.length)]!;
  const roomId = crypto.randomUUID();
  const entry: OpenRoomEntry = { roomId, topology, joined: 1, createdAt: Date.now() };
  await env.LOBBY_CODES.put(`${OPEN_ROOM_PREFIX}${roomId}`, JSON.stringify(entry), {
    expirationTtl: OPEN_ROOM_TTL_S,
  });
  return json<MatchmakeJoinResponse>({ roomId, wsUrl: wsUrlFor(env, roomId, topology) });
}

async function findReusableOpenRoom(env: Env): Promise<OpenRoomEntry | null> {
  const list = await env.LOBBY_CODES.list({ prefix: OPEN_ROOM_PREFIX, limit: 50 });
  let best: OpenRoomEntry | null = null;
  for (const item of list.keys) {
    const raw = await env.LOBBY_CODES.get(item.name);
    if (!raw) continue;
    const entry = JSON.parse(raw) as OpenRoomEntry;
    if (entry.joined >= OPEN_ROOM_SOFT_CAPACITY) continue;
    if (!best || entry.joined > best.joined) best = entry;
  }
  if (best === null) return null;
  best.joined += 1;
  await env.LOBBY_CODES.put(`${OPEN_ROOM_PREFIX}${best.roomId}`, JSON.stringify(best), {
    expirationTtl: OPEN_ROOM_TTL_S,
  });
  return best;
}

async function freshCode(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomCode();
    const existing = await env.LOBBY_CODES.get(code);
    if (!existing) return code;
  }
  throw new Error('failed to allocate code');
}

function randomCode(): string {
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) {
    out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return out;
}

function wsUrlFor(env: Env, roomId: string, topology: Topology): string {
  const subdomain = env.WORKERS_SUBDOMAIN ? `${env.WORKERS_SUBDOMAIN}.` : '';
  // Stamp topology onto the URL so the Room DO can call setTopology on its
  // first fetch, before any client connects. Without this the room would
  // default to 'plane' regardless of what the matchmaker chose or the
  // lobby selected.
  return `wss://${env.ROOM_WORKER}.${subdomain}workers.dev/ws/${roomId}?topology=${topology}`;
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(): Response {
  return error(404, 'not_found');
}

function error(status: number, code: string): Response {
  return json({ error: code }, status);
}
