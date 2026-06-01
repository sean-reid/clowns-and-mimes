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

import type {
  Item,
  ItemType,
  PlayerState,
  Portal,
  ServerToClient,
  Topology,
  Vec3,
} from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import {
  CLOAK_DURATION_MS,
  ITEM_PICKUP_RADIUS,
  ITEM_RESPAWN_MS,
  RADAR_DURATION_MS,
  itemSpawnLayout,
} from '@cm/shared/items';
import { SURGE_DURATION_MS } from '@cm/shared/movement';
import {
  buildPortalPair,
  PORTAL_DURATION_MS,
  PORTAL_ENTER_RADIUS,
  PORTAL_TELEPORT_COOLDOWN_MS,
} from '@cm/shared/portals';
import { topologyDistance } from '@cm/shared/topology';

// respawnAt is 0 when the item is on the floor; once picked up it holds the
// wall-clock ms at which the item reappears.
export interface ItemState {
  id: string;
  type: ItemType;
  position: Vec3;
  respawnAt: number;
}

// A live portal pair. Wire form (Portal) carries only the two wall-anchored
// mouth points; the off-wall emergence points stay server-side.
interface PortalRecord {
  id: string;
  a: Vec3;
  b: Vec3;
  aExit: Vec3;
  bExit: Vec3;
  aExitYaw: number;
  bExitYaw: number;
  expiresAt: number;
  // Player who opened the pair. Mouth `a` is on their entry side, so a bot
  // opener can find it again to follow through on its own portal.
  openerId: string;
}

export interface ItemManagerHost {
  readonly players: Map<string, PlayerState>;
  readonly connections: Map<WebSocket, { playerId: string }>;
  readonly worldWidth: number;
  getTopology(): Topology;
  getSeed(): number;
  getWalls(): readonly WallSegment[];
  broadcast(msg: ServerToClient): void;
  // Spawn a temporary ally bot (Clone power-up) near and on the team of the
  // activating player. Owned by BotManager, which despawns it on expiry.
  spawnClone(owner: PlayerState): void;
}

export class ItemManager {
  private readonly items = new Map<string, ItemState>();
  // Live portal pairs, keyed by id. Ephemeral (PORTAL_DURATION_MS), so not
  // persisted - a deploy mid-pair drops it, which is shorter than the DO
  // eviction window anyway.
  private readonly portals = new Map<string, PortalRecord>();
  // Players currently occupying a mouth they should not (re)trigger from: the
  // opener at creation, and anyone who just emerged. Cleared the tick they step
  // clear of every mouth, so re-entering teleports again (pairs are two-way).
  private readonly portalBlocked = new Set<string>();
  // playerId -> earliest time (ms) they may be teleported again. Set on every
  // teleport so a player who emerges facing a mouth can't bounce through it on
  // the next tick; re-entry resumes once the cooldown lapses.
  private readonly portalCooldownUntil = new Map<string, number>();
  private portalSeq = 0;

  constructor(private readonly host: ItemManagerHost) {}

  /** Build the deterministic layout from the seed. Called on match start. */
  spawn(): void {
    this.items.clear();
    this.portals.clear();
    this.portalBlocked.clear();
    this.portalCooldownUntil.clear();
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
    const now = Date.now();
    this.stepPortals(now);
    if (this.items.size === 0) return;
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
   * Activate the held power-up. Clears the slot, applies the per-type
   * effect, and broadcasts item_used. No-op when empty.
   */
  onUseItem(ws: WebSocket): void {
    const conn = this.host.connections.get(ws);
    if (!conn) return;
    const player = this.host.players.get(conn.playerId);
    if (!player) return;
    this.activate(player);
  }

  /** Bot-side activation: same effect + event as onUseItem, no connection. */
  useItemForBot(player: PlayerState): void {
    this.activate(player);
  }

  private activate(player: PlayerState): void {
    if (player.activeItem === undefined) return;
    const itemType = player.activeItem;
    delete player.activeItem;
    this.applyEffect(player, itemType);
    this.host.broadcast({ t: 'event', kind: { kind: 'item_used', playerId: player.id, itemType } });
  }

  /** Per-type effect dispatch. Types not yet implemented are no-ops. */
  private applyEffect(player: PlayerState, type: ItemType): void {
    switch (type) {
      case 'leap':
        // Arm the next jump to use the boosted arc. The simulation consumes
        // this flag when the player's next jump triggers.
        player.leapArmed = true;
        break;
      case 'portal':
        this.openPortal(player);
        break;
      case 'surge':
        // Sprint boost for a fixed window. Stored as an absolute deadline so
        // the simulation and client predictor agree without further events.
        player.surgeUntil = Date.now() + SURGE_DURATION_MS;
        break;
      case 'clone':
        this.host.spawnClone(player);
        break;
      case 'radar':
        // Reveal the enemy team on the activating player's minimap for a fixed
        // window. Like surge, stored as an absolute deadline that rides the
        // snapshot; the minimap HUD reads it.
        player.radarUntil = Date.now() + RADAR_DURATION_MS;
        break;
      case 'overcharge':
        // Arm the next shot to skip the cooldown and pierce walls. The
        // ProjectileManager consumes the flag when that shot fires.
        player.overchargeArmed = true;
        break;
      case 'cloak':
        // Hide this body from other clients for a fixed window. Visual only,
        // stored as an absolute deadline that rides the snapshot; remote
        // clients hide the body while it is in the future.
        player.cloakUntil = Date.now() + CLOAK_DURATION_MS;
        break;
      default:
        break;
    }
  }

  /**
   * Open a portal pair: entry mouth on the wall the player faces, exit on a
   * random other wall. Broadcasts portal_open; the pair rides the snapshot too.
   * The opener is blocked from this pair until they step clear, so activating
   * doesn't instantly teleport them off the entry mouth they're standing on.
   */
  private openPortal(player: PlayerState): void {
    const geom = buildPortalPair(
      { x: player.position.x, z: player.position.z },
      player.yaw,
      this.host.getWalls(),
      this.host.getTopology(),
      this.host.worldWidth,
    );
    if (geom === null) return;
    const id = `p-${this.portalSeq}`;
    this.portalSeq += 1;
    const portal: PortalRecord = {
      id,
      ...geom,
      expiresAt: Date.now() + PORTAL_DURATION_MS,
      openerId: player.id,
    };
    this.portals.set(id, portal);
    this.portalBlocked.add(player.id);
    this.host.broadcast({
      t: 'event',
      kind: { kind: 'portal_open', portal: toWirePortal(portal) },
    });
  }

  /**
   * Expire elapsed pairs (broadcasting portal_close), then teleport any player
   * standing within PORTAL_ENTER_RADIUS of a mouth to the opposite mouth's
   * emergence point. The blocked set stops the just-emerged (and the opener)
   * from bouncing back until they step clear.
   */
  private stepPortals(now: number): void {
    if (this.portals.size === 0) {
      if (this.portalBlocked.size > 0) this.portalBlocked.clear();
      if (this.portalCooldownUntil.size > 0) this.portalCooldownUntil.clear();
      return;
    }
    for (const portal of this.portals.values()) {
      if (portal.expiresAt <= now) {
        this.portals.delete(portal.id);
        this.host.broadcast({ t: 'event', kind: { kind: 'portal_close', id: portal.id } });
      }
    }
    if (this.portals.size === 0) {
      this.portalBlocked.clear();
      this.portalCooldownUntil.clear();
      return;
    }
    const topology = this.host.getTopology();
    const width = this.host.worldWidth;
    for (const player of this.host.players.values()) {
      let dest: Vec3 | null = null;
      let destYaw = 0;
      for (const portal of this.portals.values()) {
        if (topologyDistance(player.position, portal.a, topology, width) <= PORTAL_ENTER_RADIUS) {
          dest = portal.bExit;
          destYaw = portal.bExitYaw;
          break;
        }
        if (topologyDistance(player.position, portal.b, topology, width) <= PORTAL_ENTER_RADIUS) {
          dest = portal.aExit;
          destYaw = portal.aExitYaw;
          break;
        }
      }
      if (dest === null) {
        this.portalBlocked.delete(player.id);
        continue;
      }
      if (this.portalBlocked.has(player.id)) continue;
      if (now < (this.portalCooldownUntil.get(player.id) ?? 0)) continue;
      player.position = { x: dest.x, y: player.position.y, z: dest.z };
      // Face away from the exit wall. The position rides the next delta, but
      // the local player's yaw is client-owned, so emit it for that client to
      // snap; remote bodies adopt it from the delta's yaw field.
      player.yaw = destYaw;
      this.portalBlocked.add(player.id);
      this.portalCooldownUntil.set(player.id, now + PORTAL_TELEPORT_COOLDOWN_MS);
      this.host.broadcast({
        t: 'event',
        kind: { kind: 'player_teleport', playerId: player.id, yaw: destYaw },
      });
    }
  }

  /** Live portal pairs, for the snapshot. */
  activePortals(): Portal[] {
    return [...this.portals.values()].map(toWirePortal);
  }

  /**
   * The entry/exit mouths of a live portal `playerId` opened, or null if they
   * have none. Lets a bot opener path back to its own entry mouth (`a`) to take
   * the portal rather than wander off and waste it.
   */
  portalFor(playerId: string): { a: Vec3; b: Vec3 } | null {
    for (const portal of this.portals.values()) {
      if (portal.openerId === playerId) return { a: portal.a, b: portal.b };
    }
    return null;
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
    this.portals.clear();
    this.portalBlocked.clear();
    this.portalCooldownUntil.clear();
  }
}

function toWire(item: ItemState): Item {
  return { id: item.id, type: item.type, position: item.position };
}

function toWirePortal(p: PortalRecord): Portal {
  return { id: p.id, a: p.a, b: p.b, expiresAt: p.expiresAt };
}
