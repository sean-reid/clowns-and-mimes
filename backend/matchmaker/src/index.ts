import type {
  MatchmakeCreateBody,
  MatchmakeCreateResponse,
  MatchmakeJoinResponse,
  Topology,
} from '@cm/shared';
import { PROTOCOL_VERSION } from '@cm/shared';
import { MatchmakerDO, VALID_TOPOLOGIES } from './matchmakerDO.ts';

export { MatchmakerDO };

export interface Env {
  LOBBY_CODES: KVNamespace;
  MATCHMAKER_DO: DurableObjectNamespace;
  ROOM_WORKER: string;
  WORKERS_SUBDOMAIN: string;
  ENV: string;
}

const CODE_LENGTH = 6;
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const PRIVATE_ROOM_TTL_S = 60 * 60 * 6;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json({ ok: true, env: env.ENV });
    }
    // Protocol-version gate for the player-facing endpoints. Worker-to-DO
    // forwards skip the check; the room-state / room-detach paths are
    // server-internal. The healthz endpoint is also skipped so monitoring
    // doesn't have to know about our version scheme.
    if (
      url.pathname === '/lobby' ||
      url.pathname.match(/^\/lobby\/[A-Z0-9]+\/join$/) ||
      url.pathname === '/open/join'
    ) {
      const mismatch = enforceProtocolVersion(req);
      if (mismatch !== null) return mismatch;
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
    if (req.method === 'POST' && url.pathname === '/lobby/room-state') {
      return forwardToDO(env, '/roomState', req);
    }
    if (req.method === 'POST' && url.pathname === '/lobby/room-detach') {
      return forwardToDO(env, '/roomDetach', req);
    }
    return notFound();
  },
};

/**
 * Check the client's protocol version against the server. Returns a 426
 * response when they disagree, or null when the request may proceed.
 * Missing header is treated as a mismatch - older clients without the
 * header would have a stale protocol anyway, and the new client always
 * sends it.
 */
function enforceProtocolVersion(req: Request): Response | null {
  const header = req.headers.get('x-protocol-version');
  const clientV = header ? Number(header) : NaN;
  if (!Number.isFinite(clientV) || clientV !== PROTOCOL_VERSION) {
    return json(
      {
        error: 'protocol_mismatch',
        server_v: PROTOCOL_VERSION,
        client_v: Number.isFinite(clientV) ? clientV : null,
      },
      426,
    );
  }
  return null;
}

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
  // hostToken is the random secret the host uses to prove they are the
  // host on their WS join. Joiners (POST /lobby/:code/join) never see it -
  // they just get the wsUrl. Stored alongside roomId / topology so it
  // survives the matchmaker worker bouncing between requests.
  const hostToken = crypto.randomUUID();
  await env.LOBBY_CODES.put(
    code,
    JSON.stringify({ roomId, topology: body.topology, createdAt: Date.now(), hostToken }),
    { expirationTtl: PRIVATE_ROOM_TTL_S },
  );
  const res: MatchmakeCreateResponse = {
    code,
    roomId,
    wsUrl: wsUrlFor(env, roomId, body.topology, hostToken),
    hostToken,
  };
  return json(res);
}

async function joinByCode(code: string, env: Env): Promise<Response> {
  const raw = await env.LOBBY_CODES.get(code);
  if (!raw) return error(404, 'room_not_found');
  // Deliberately do NOT return the hostToken to a joiner. Only the response
  // body of POST /lobby (createPrivateLobby) ever surfaces it.
  const parsed = JSON.parse(raw) as { roomId: string; topology: Topology };
  const res: MatchmakeJoinResponse = {
    roomId: parsed.roomId,
    wsUrl: wsUrlFor(env, parsed.roomId, parsed.topology),
  };
  return json(res);
}

async function joinOpenRoom(env: Env): Promise<Response> {
  const doRes = await callDO(env, '/openJoin', { method: 'POST', body: '{}' });
  if (!doRes.ok) {
    return error(500, 'matchmaker_unavailable');
  }
  const parsed = (await doRes.json()) as { roomId: string; topology: Topology };
  const res: MatchmakeJoinResponse & { topology: Topology } = {
    roomId: parsed.roomId,
    wsUrl: wsUrlFor(env, parsed.roomId, parsed.topology),
    topology: parsed.topology,
  };
  return json(res);
}

async function forwardToDO(env: Env, path: string, req: Request): Promise<Response> {
  const bodyText = await req.text();
  return callDO(env, path, {
    method: 'POST',
    body: bodyText,
    headers: { 'content-type': 'application/json' },
  });
}

function callDO(env: Env, path: string, init: RequestInit): Promise<Response> {
  const id = env.MATCHMAKER_DO.idFromName('v1');
  const stub = env.MATCHMAKER_DO.get(id);
  return stub.fetch(`https://matchmaker-do.internal${path}`, init);
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

function wsUrlFor(env: Env, roomId: string, topology: Topology, hostToken?: string): string {
  const subdomain = env.WORKERS_SUBDOMAIN ? `${env.WORKERS_SUBDOMAIN}.` : '';
  // Stamp topology onto the URL so the Room DO can call setTopology on its
  // first fetch, before any client connects. Without this the room would
  // default to 'plane' regardless of what the matchmaker chose or the
  // lobby selected.
  let url = `wss://${env.ROOM_WORKER}.${subdomain}workers.dev/ws/${roomId}?topology=${topology}`;
  // Host-flavoured URL carries the hostToken as a query param. The Room DO
  // reads it on WS upgrade and remembers it as the room's expected host
  // secret; the host's `join` message must then carry the same token in
  // its body to claim the role. Joiners (POST /lobby/:code/join) never get
  // this URL - they receive the plain one from joinByCode.
  if (hostToken) {
    url += `&host=${encodeURIComponent(hostToken)}`;
  }
  return url;
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
