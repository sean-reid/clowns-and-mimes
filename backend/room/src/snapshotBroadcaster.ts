// Wire-output side of the Room. Owns the per-tick delta builder, the
// one-shot full-snapshot builder, and the broadcast/send fanout.
// Lifted out of room.ts so the network surface can be unit-tested with
// a mock connections map; behavior is unchanged.

import type {
  Item,
  PlayerState,
  Projectile,
  RoomPhase,
  RoomSnapshot,
  ServerToClient,
  Topology,
} from '@cm/shared';
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
  getProjectiles(): Projectile[];
  getItems(): Item[];
}

export class SnapshotBroadcaster {
  constructor(private readonly host: SnapshotBroadcasterHost) {}

  broadcastDelta(): void {
    const players = [...this.host.players.values()];
    const phase = this.host.getPhase();
    const turnEndsAt = this.host.getTurnEndsAt();
    // Omit the field entirely when no projectiles are live so the common
    // case keeps the delta small; clients treat absent as empty.
    const live = this.host.getProjectiles();
    const projectiles = live.length > 0 ? live : undefined;
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
        projectiles,
      });
    }
  }

  snapshot(): RoomSnapshot {
    // Items are static between pickups, so they ride the snapshot rather
    // than the per-tick delta. Omitted when none are on the floor.
    const items = this.host.getItems();
    return {
      v: PROTOCOL_VERSION,
      roomId: this.host.getRoomId(),
      seed: this.host.getSeed(),
      topology: this.host.getTopology(),
      phase: this.host.getPhase(),
      turnEndsAt: this.host.getTurnEndsAt(),
      players: [...this.host.players.values()],
      ...(items.length > 0 ? { items } : {}),
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
