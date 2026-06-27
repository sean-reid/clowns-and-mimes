// Runtime validation for incoming WebSocket messages. JSON.parse returns
// `any`, and the existing `as ClientToServer` cast is a TypeScript lie:
// a malicious or buggy client can send a wrong-shape payload and the
// handler downstream will dereference undefined or pass NaN into the
// movement step.
//
// Hand-rolled per-variant guards rather than a schema library. The wire
// protocol is small and stable; pulling in zod for ~7 message kinds is
// not worth the cold-start size on a Cloudflare Worker.

import type { ClientToServer, PlayerInput, Team, Topology } from '@cm/shared';

function isFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isBounded(v: unknown, lo: number, hi: number): v is number {
  return isFinite(v) && v >= lo && v <= hi;
}

function isStr(v: unknown, maxLen = 256): v is string {
  return typeof v === 'string' && v.length <= maxLen;
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isTeam(v: unknown): v is Team {
  return v === 'mime' || v === 'clown';
}

function isTopology(v: unknown): v is Topology {
  return v === 'plane' || v === 'torus' || v === 'mobius' || v === 'klein';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateInput(input: unknown): PlayerInput | null {
  if (!isObj(input)) return null;
  if (!isSafeInt(input.seq) || input.seq > 2 ** 31) return null;
  if (!isBounded(input.dt, 0, 1)) return null;
  if (!isObj(input.move)) return null;
  if (!isBounded(input.move.x, -1.5, 1.5)) return null;
  if (!isBounded(input.move.z, -1.5, 1.5)) return null;
  if (!isFinite(input.lookYaw)) return null;
  if (input.lookPitch !== undefined && !isFinite(input.lookPitch)) return null;
  if (!isBool(input.sprint)) return null;
  if (!isSafeInt(input.nowMs)) return null;
  if (input.jump !== undefined && !isBool(input.jump)) return null;
  if (input.actionTag !== undefined && !isStr(input.actionTag)) return null;
  if (input.actionUnfreeze !== undefined && !isStr(input.actionUnfreeze)) return null;
  return {
    seq: input.seq,
    dt: input.dt,
    move: { x: input.move.x, z: input.move.z },
    lookYaw: input.lookYaw,
    lookPitch: input.lookPitch as number | undefined,
    sprint: input.sprint,
    nowMs: input.nowMs,
    jump: input.jump as boolean | undefined,
    actionTag: input.actionTag as string | undefined,
    actionUnfreeze: input.actionUnfreeze as string | undefined,
  };
}

/**
 * Validate a freshly-parsed message off the wire. Returns the typed
 * value on success, or null when the shape doesn't match a known
 * ClientToServer variant. Callers should send an `invalid_message`
 * error and drop the connection rather than guessing.
 */
export function parseClientMessage(raw: unknown): ClientToServer | null {
  if (!isObj(raw)) return null;
  const t = raw.t;
  switch (t) {
    case 'join': {
      if (!isStr(raw.name, 96)) return null;
      if (!isFinite(raw.v)) return null;
      if (raw.preferTeam !== undefined && !isTeam(raw.preferTeam)) return null;
      if (raw.hostToken !== undefined && !isStr(raw.hostToken, 128)) return null;
      if (raw.sessionToken !== undefined && !isStr(raw.sessionToken, 128)) return null;
      // Party grouping: without passing these through, the room never learns a
      // joiner is in a party, treats party members as solos, and the match-start
      // balance splits them across teams.
      if (raw.partyId !== undefined && !isStr(raw.partyId, 64)) return null;
      if (raw.partySize !== undefined && !isFinite(raw.partySize)) return null;
      return {
        t: 'join',
        name: raw.name,
        v: raw.v,
        preferTeam: raw.preferTeam as Team | undefined,
        hostToken: raw.hostToken as string | undefined,
        sessionToken: raw.sessionToken as string | undefined,
        partyId: raw.partyId as string | undefined,
        partySize: raw.partySize as number | undefined,
      };
    }
    case 'leave':
      return { t: 'leave' };
    case 'input': {
      const input = validateInput(raw.input);
      if (input === null) return null;
      return { t: 'input', input };
    }
    case 'tag_attempt': {
      if (!isStr(raw.targetId, 128)) return null;
      if (!isFinite(raw.clientTime)) return null;
      return { t: 'tag_attempt', targetId: raw.targetId, clientTime: raw.clientTime };
    }
    case 'unfreeze_attempt': {
      if (!isStr(raw.targetId, 128)) return null;
      if (!isFinite(raw.clientTime)) return null;
      return { t: 'unfreeze_attempt', targetId: raw.targetId, clientTime: raw.clientTime };
    }
    case 'ping': {
      if (!isFinite(raw.clientTime)) return null;
      return { t: 'ping', clientTime: raw.clientTime };
    }
    case 'shoot': {
      if (!isFinite(raw.dirX) || !isFinite(raw.dirY) || !isFinite(raw.dirZ)) return null;
      if (!isSafeInt(raw.nowMs)) return null;
      return { t: 'shoot', dirX: raw.dirX, dirY: raw.dirY, dirZ: raw.dirZ, nowMs: raw.nowMs };
    }
    case 'start_match':
      return { t: 'start_match' };
    case 'use_item':
      return { t: 'use_item' };
    case 'restart_room': {
      if (raw.topology !== undefined && !isTopology(raw.topology)) return null;
      return { t: 'restart_room', topology: raw.topology as Topology | undefined };
    }
    default:
      return null;
  }
}
