# Backend

Cloudflare Workers that host the multiplayer side of the game. Three packages, all TypeScript, all under the `pnpm` workspace at the repo root.

## Layout

```
backend/
├── matchmaker/   # @cm/matchmaker — public HTTP entry + matchmaking DO
├── room/         # @cm/room       — per-match Durable Object (game state + WS)
└── shared/       # @cm/shared     — code used by both, AND by the Godot client
```

### `@cm/shared`

Pure logic used on the server, on the client (via Godot's port of the same algorithms), and from the test suites. Anything in here that the client also implements (`movement.ts`, `physics.ts`, `topology.ts`, `labyrinth.ts`, `gridMaze.ts`, `mobius.ts`) must stay bit-identical with `game/scripts/*.gd` — divergence causes prediction reconciliation oscillation.

`protocol.ts` is the WebSocket message schema (client ↔ room).

### `@cm/matchmaker`

HTTP endpoints the client hits before joining a match: code rooms, public-room listing, room provisioning. Backed by `MatchmakerDO`, a single Durable Object that holds the open-rooms pool and KV-stored lobby codes.

### `@cm/room`

One Durable Object instance per active match. Owns the entire game state — players, turn phase, bot AI, tick loop — and broadcasts WebSocket snapshots / deltas to every connected client. Uses the Hibernation API (`state.acceptWebSocket`) so an empty room can sleep without paying CPU.

## Local development

```bash
# From the repo root
pnpm install            # one time
pnpm --filter @cm/matchmaker dev    # starts wrangler dev on a local port
pnpm --filter @cm/room dev          # in another terminal
```

The matchmaker reads `ROOM_WORKER` from `wrangler.toml` to know which room service to proxy WebSocket joins to. For full local play the Godot client needs `CLOWNS_MM_URL` pointed at the matchmaker's local port — see [reference_offline_mode_entry.md] for how the client falls into offline mode when the matchmaker can't be reached.

## Tests

```bash
pnpm --filter @cm/shared test         # topology, labyrinth, physics, mobius
pnpm --filter @cm/matchmaker test     # matchmakerDO + index routing
pnpm --filter @cm/room test           # team balance, worker entry
```

All tests run under Vitest. The CI workflow (`.github/workflows/ci.yml`) runs the same commands plus the headless Godot test runner for the GDScript side.

## Deploying

The release workflow (`.github/workflows/release.yml`) deploys both Workers to production when a `v*` tag is pushed. A separate dev-deploy workflow (`.github/workflows/deploy-dev.yml`) runs on every push to `dev`. Manual deploys:

```bash
pnpm --filter @cm/matchmaker deploy:dev
pnpm --filter @cm/room deploy:dev
# or :production
```

Both require `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.

## Protocol overview

1. Client `POST`s to the matchmaker (`/host`, `/code`, `/strangers`) which returns a room URL + session-bound `hostToken` and/or `sessionToken`.
2. Client opens a WebSocket to that room URL. First message is `{ t: 'join', name, v, preferTeam?, hostToken?, sessionToken? }`.
3. Server sends `{ t: 'snapshot' }` with the full world state + the client's `playerId` and a fresh `sessionToken`. Save it — the client can present it on reconnect to resume the same slot inside `RECONNECT_GRACE_MS`.
4. Client streams `{ t: 'input' }` at the input tick rate. Each input has a monotonic `seq` so the server can ack with `ackSeq` in every `delta`.
5. Server broadcasts `{ t: 'delta' }` per game tick with the player roster (positions, velocities, sprint, frozen, jumpStartedAt), phase, and `ackSeq`.

Tag and unfreeze go through their own client → server messages and produce a `{ t: 'tag_result' }` ack. See `backend/shared/src/protocol.ts` for the full schema.

## Adding a new client → server message

1. Add the variant to `ClientToServer` in `backend/shared/src/protocol.ts`.
2. Add the handler branch in `backend/room/src/room.ts`'s `webSocketMessage`.
3. Bump `PROTOCOL_VERSION` in `protocol.ts` if existing clients can't parse the new shape.
4. Mirror the change on the GDScript side (`game/scripts/network/room_client.gd`).
5. Add a Vitest case under `backend/room/src/` covering the new handler.
