import { describe, expect, it } from 'vitest';
import { parseClientMessage } from './messageValidator.ts';

const validInput = () => ({
  seq: 1,
  dt: 1 / 60,
  move: { x: 0, z: 0 },
  lookYaw: 0,
  sprint: false,
  nowMs: 1_700_000_000_000,
});

describe('parseClientMessage', () => {
  it('rejects non-objects', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage(42)).toBeNull();
    expect(parseClientMessage('hello')).toBeNull();
    expect(parseClientMessage([])).toBeNull();
  });

  it('rejects unknown message kinds', () => {
    expect(parseClientMessage({ t: 'bogus' })).toBeNull();
  });

  describe('join', () => {
    it('accepts a minimal valid join', () => {
      const r = parseClientMessage({ t: 'join', name: 'Alice', v: 2 });
      expect(r).toEqual({
        t: 'join',
        name: 'Alice',
        v: 2,
        preferTeam: undefined,
        hostToken: undefined,
        sessionToken: undefined,
        partyId: undefined,
        partySize: undefined,
      });
    });

    it('passes through optional fields', () => {
      const r = parseClientMessage({
        t: 'join',
        name: 'Alice',
        v: 2,
        preferTeam: 'mime',
        hostToken: 'abc',
        sessionToken: 'def',
      });
      expect(r?.t).toBe('join');
      if (r?.t === 'join') {
        expect(r.preferTeam).toBe('mime');
        expect(r.hostToken).toBe('abc');
        expect(r.sessionToken).toBe('def');
      }
    });

    it('passes through party fields so the room can group a party', () => {
      // Regression: these were dropped by the validator, so the room treated
      // party members as solos and the match-start balance split them.
      const r = parseClientMessage({
        t: 'join',
        name: 'Alice',
        v: 2,
        partyId: 'aef5d640-e13d-4386-8ba1-767e68bc9c94',
        partySize: 2,
      });
      expect(r?.t).toBe('join');
      if (r?.t === 'join') {
        expect(r.partyId).toBe('aef5d640-e13d-4386-8ba1-767e68bc9c94');
        expect(r.partySize).toBe(2);
      }
    });

    it('rejects a non-string partyId', () => {
      expect(parseClientMessage({ t: 'join', name: 'A', v: 2, partyId: 123 })).toBeNull();
    });

    it('rejects invalid preferTeam', () => {
      expect(parseClientMessage({ t: 'join', name: 'A', v: 2, preferTeam: 'admin' })).toBeNull();
    });

    it('rejects overlong name', () => {
      const name = 'a'.repeat(200);
      expect(parseClientMessage({ t: 'join', name, v: 2 })).toBeNull();
    });
  });

  describe('input', () => {
    it('accepts a valid input', () => {
      const r = parseClientMessage({ t: 'input', input: validInput() });
      expect(r?.t).toBe('input');
    });

    it('rejects NaN dt', () => {
      const bad = { ...validInput(), dt: NaN };
      expect(parseClientMessage({ t: 'input', input: bad })).toBeNull();
    });

    it('rejects out-of-bounds move components', () => {
      const bad = { ...validInput(), move: { x: 999, z: 0 } };
      expect(parseClientMessage({ t: 'input', input: bad })).toBeNull();
    });

    it('rejects negative seq', () => {
      const bad = { ...validInput(), seq: -1 };
      expect(parseClientMessage({ t: 'input', input: bad })).toBeNull();
    });

    it('rejects non-integer seq', () => {
      const bad = { ...validInput(), seq: 1.5 };
      expect(parseClientMessage({ t: 'input', input: bad })).toBeNull();
    });

    it('rejects unsafe-large seq', () => {
      const bad = { ...validInput(), seq: 2 ** 32 };
      expect(parseClientMessage({ t: 'input', input: bad })).toBeNull();
    });

    it('rejects missing required fields', () => {
      const bad = { ...validInput() } as Record<string, unknown>;
      delete bad.sprint;
      expect(parseClientMessage({ t: 'input', input: bad })).toBeNull();
    });

    it('rejects huge dt (no teleport bursts)', () => {
      const bad = { ...validInput(), dt: 1000 };
      expect(parseClientMessage({ t: 'input', input: bad })).toBeNull();
    });

    it('accepts optional jump flag', () => {
      const r = parseClientMessage({ t: 'input', input: { ...validInput(), jump: true } });
      expect(r?.t).toBe('input');
    });
  });

  describe('tag_attempt / unfreeze_attempt', () => {
    it('accepts valid shape', () => {
      expect(parseClientMessage({ t: 'tag_attempt', targetId: 'p1', clientTime: 1 })?.t).toBe(
        'tag_attempt',
      );
      expect(parseClientMessage({ t: 'unfreeze_attempt', targetId: 'p1', clientTime: 1 })?.t).toBe(
        'unfreeze_attempt',
      );
    });

    it('rejects missing targetId', () => {
      expect(parseClientMessage({ t: 'tag_attempt', clientTime: 1 })).toBeNull();
    });

    it('rejects overlong targetId', () => {
      const targetId = 'x'.repeat(200);
      expect(parseClientMessage({ t: 'tag_attempt', targetId, clientTime: 1 })).toBeNull();
    });
  });

  describe('payload-free messages', () => {
    it('passes leave through cleanly', () => {
      expect(parseClientMessage({ t: 'leave' })).toEqual({ t: 'leave' });
    });

    it('passes start_match through cleanly', () => {
      expect(parseClientMessage({ t: 'start_match' })).toEqual({ t: 'start_match' });
    });

    it('accepts ping with clientTime', () => {
      expect(parseClientMessage({ t: 'ping', clientTime: 12345 })?.t).toBe('ping');
    });
  });

  describe('restart_room', () => {
    it('accepts a bare restart with no topology', () => {
      expect(parseClientMessage({ t: 'restart_room' })).toEqual({
        t: 'restart_room',
        topology: undefined,
      });
    });

    it('passes a valid topology through', () => {
      expect(parseClientMessage({ t: 'restart_room', topology: 'klein' })).toEqual({
        t: 'restart_room',
        topology: 'klein',
      });
    });

    it('rejects an unknown topology', () => {
      expect(parseClientMessage({ t: 'restart_room', topology: 'sphere' })).toBeNull();
    });
  });
});
