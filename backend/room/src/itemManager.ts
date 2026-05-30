// Server-side power-up lifecycle, lifted out of Room the same way
// ProjectileManager owns shooting. The deterministic floor layout + type
// rotation live in @cm/shared/items; this file owns the mutable state:
// spawning the layout at match start, the per-tick respawn + pickup pass,
// and the use_item handler. PR #5 carries state/pickup/use plumbing only;
// the per-type effects (Leap, Portal, ...) land in later PRs, so onUseItem
// just clears the slot and broadcasts.
//
// Items are static between pickups, so they ride the snapshot rather than the
// per-tick delta; pickups and respawns are surfaced as events.

import type { Item, ItemType, PlayerState, ServerToClient, Topology, Vec3 } from '@cm/shared';
import { ITEM_PICKUP_RADIUS, ITEM_RESPAWN_MS, itemSpawnLayout } from '@cm/shared/items';
import { topologyDistance } from '@cm/shared/topology';

// respawnAt is 0 when the item is on the floor; once picked up it holds the
// wall-clock ms at which the item reappears.
export interface ItemState {
  id: string;
  type: ItemType;
  position: Vec3;
  respawnAt: number;
}

export interface ItemManagerHost {
  readonly players: Map<string, PlayerState>;
  readonly connections: Map<WebSocket, { playerId: string }>;
  readonly worldWidth: number;
  getTopology(): Topology;
  getSeed(): number;
  broadcast(msg: ServerToClient): void;
}

export class ItemManager {
  private readonly items = new Map<string, ItemState>();

  constructor(private readonly host: ItemManagerHost) {}

  /** Build the deterministic layout from the seed. Called on match start. */
  spawn(): void {
    this.items.clear();
    for (const entry of itemSpawnLayout(this.host.getSeed(), this.host.getTopology())) {
      this.items.set(entry.id, { ...entry, respawnAt: 0 });
    }
  }

  /**
   * Respawn elapsed items (broadcasting item_spawn), then let each eligible
   * player grab one available item. A player holding a power-up or frozen
   * cannot pick up (no stacking); pickups stop at one per player per tick.
   */
  step(_dt: number): void {
    if (this.items.size === 0) return;
    const now = Date.now();
    for (const item of this.items.values()) {
      if (item.respawnAt > 0 && item.respawnAt <= now) {
        item.respawnAt = 0;
        this.host.broadcast({ t: 'event', kind: { kind: 'item_spawn', item: toWire(item) } });
      }
    }
    const topology = this.host.getTopology();
    for (const player of this.host.players.values()) {
      if (player.frozen || player.activeItem !== undefined) continue;
      for (const item of this.items.values()) {
        if (item.respawnAt !== 0) continue;
        const d = topologyDistance(player.position, item.position, topology, this.host.worldWidth);
        if (d > ITEM_PICKUP_RADIUS) continue;
        player.activeItem = item.type;
        item.respawnAt = now + ITEM_RESPAWN_MS;
        this.host.broadcast({
          t: 'event',
          kind: { kind: 'item_pickup', itemId: item.id, playerId: player.id },
        });
        break;
      }
    }
  }

  /**
   * Activate the held power-up. Clears the slot and broadcasts item_used;
   * the per-type effect is dispatched in later PRs. No-op when empty.
   */
  onUseItem(ws: WebSocket): void {
    const conn = this.host.connections.get(ws);
    if (!conn) return;
    const player = this.host.players.get(conn.playerId);
    if (!player || player.activeItem === undefined) return;
    const itemType = player.activeItem;
    delete player.activeItem;
    this.host.broadcast({ t: 'event', kind: { kind: 'item_used', playerId: player.id, itemType } });
  }

  /** Items currently on the floor, for the snapshot. */
  available(): Item[] {
    const out: Item[] = [];
    for (const item of this.items.values()) {
      if (item.respawnAt === 0) out.push(toWire(item));
    }
    return out;
  }

  /** Full state for persistence (includes in-flight respawn timers). */
  export(): ItemState[] {
    return [...this.items.values()];
  }

  /** Rehydrate from a persisted blob after DO wake. */
  restore(states: ItemState[]): void {
    this.items.clear();
    for (const s of states) this.items.set(s.id, { ...s });
  }

  clear(): void {
    this.items.clear();
  }
}

function toWire(item: ItemState): Item {
  return { id: item.id, type: item.type, position: item.position };
}
