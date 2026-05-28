// Wire-output side of the Room. Owns the per-tick delta builder, the
// one-shot full-snapshot builder, and the broadcast/send fanout.
// Lifted out of room.ts so the network surface can be unit-tested with
// a mock connections map; behavior is unchanged.

import type { PlayerState, RoomPhase, RoomSnapshot, ServerToClient, Topology } from '@cm/shared';
import { PROTOCOL_VERSION } from '@cm/shared';

export interface BroadcastConnection {
  ws: WebSocket;
  playerId: string;
}

export interface SnapshotBroadcasterHost {
  readonly players: Map<string, PlayerState>;
  readonly connections: Map<WebSocket, BroadcastConnection>;
  readonly lastAppliedSeq: Map<string, number>;
  getPhase(): RoomPhase;
  getTurnEndsAt(): number;
  getSeed(): number;
  getTopology(): Topology;
  getRoomId(): string;
}

export class SnapshotBroadcaster {
  constructor(private readonly host: SnapshotBroadcasterHost) {}

  broadcastDelta(): void {
    const players = [...this.host.players.values()];
    const phase = this.host.getPhase();
    const turnEndsAt = this.host.getTurnEndsAt();
    for (const conn of this.host.connections.values()) {
      this.send(conn.ws, {
        t: 'delta',
        players,
        phase,
        turnEndsAt,
        // ackSeq is the seq of the input most recently applied in
        // simulateHumans, not the most recently received. The client uses
        // this to know which buffered inputs to drop and which to replay
        // when reconciling its predicted position with the server's truth.
        ackSeq: this.host.lastAppliedSeq.get(conn.playerId) ?? 0,
      });
    }
  }

  snapshot(): RoomSnapshot {
    return {
      v: PROTOCOL_VERSION,
      roomId: this.host.getRoomId(),
      seed: this.host.getSeed(),
      topology: this.host.getTopology(),
      phase: this.host.getPhase(),
      turnEndsAt: this.host.getTurnEndsAt(),
      players: [...this.host.players.values()],
    };
  }

  broadcast(msg: ServerToClient): void {
    for (const conn of this.host.connections.values()) {
      this.send(conn.ws, msg);
    }
  }

  send(ws: WebSocket, msg: ServerToClient): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket likely closed; cleanup happens on close event
    }
  }
}
