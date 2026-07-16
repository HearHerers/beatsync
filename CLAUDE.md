# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Beatsync is a high-precision web audio player for multi-device synchronized playback. Turborepo monorepo with three packages:

- **`apps/client`**: Next.js 15 (App Router, React 19, Tailwind v4, Shadcn/ui)
- **`apps/server`**: Bun HTTP + WebSocket server (native `Bun.serve`, not Hono routing)
- **`packages/shared`**: Zod schemas shared across client/server (`@beatsync/shared`)

## Commands

```bash
bun install              # Install all dependencies (run from root)
bun dev                  # Start both client and server (Turborepo)
bun client               # Client only (port 3000)
bun server               # Server only (port 8080)
bun build                # Build all packages

# Server-specific (run from apps/server/)
bun test                 # Run tests (Bun test runner)
bun test --watch         # Watch mode
bun run rooms:list       # List persisted rooms from the latest R2 backup (offline)
bun run room:info <id>   # Room detail: zones, playlists, clients (offline)
# Both accept --sync: asks the running server (POST /admin/backup, needs
# OPERATOR_SECRET) to write a fresh backup first instead of reading up-to-60s-stale data.
bun run room:archive <id>    # Soft delete: evict + hide + reject joins; reversible
bun run room:unarchive <id>  # Reverse an archive
bun run room:delete <id> --yes  # HARD delete: purge state + R2 audio, tombstoned
bun run rooms:purge --yes    # HARD delete EVERY room + all audio (incl. orphans)
bun run room:import <roomId> <dir>  # Bulk-import local audio files into a room via the running server (--context <shapeId> for a zone, --dry-run to preview). For <shapeId> use a zone id from `bun run room:info <roomId>`.
# The mutations call the running server's /admin API (OPERATOR_SECRET bearer).
# On hosts where nested `bun` isn't on the package-script shell's PATH (e.g. the
# deploy server), invoke the script files directly instead of the `bun run` aliases:
#   bun scripts/rooms-list.ts [--sync] [--show-tokens]
#   bun scripts/room-info.ts <id> [--sync]
#   bun scripts/room-manage.ts archive|unarchive <id>
#   bun scripts/room-manage.ts delete <id> --yes
#   bun scripts/room-manage.ts purge [--yes]
#   bun scripts/room-admin-token.ts <id>
#   bun scripts/import-tracks.ts <roomId> <file-or-dir>... [--context <shapeId>] [--concurrency <n>] [--dry-run]
bun run type-check       # tsc --noEmit

# Client-specific (run from apps/client/)
bun lint                 # next lint
```

## Architecture

### Server Manager Hierarchy

The server uses a manager pattern with in-memory state (no database):

- **`GlobalManager`** (singleton): Manages all rooms. Accessed via `GlobalManager.rooms`. Caches active user count with dirty flag.
- **`RoomManager`** (per-room): Owns clients, audio sources, playback state, spatial audio config, chat. Handles audio loading coordination and synchronized play scheduling.
- **`ChatManager`** (per-room, owned by RoomManager): Message history with incremental IDs.
- **`BackupManager`** (singleton): Periodic state backup/restore to R2 (every 60s). Restores on startup.
- **`MusicProviderManager`**: External music search and streaming integration.

### WebSocket Protocol

All WebSocket messages are validated with Zod discriminated unions. The flow:

1. Client connects → `handleOpen()` subscribes to room topic, sends initial room state
2. Incoming messages validated against `WSRequestSchema` → dispatched via `WebsocketRegistry` (type-safe handler map in `apps/server/src/websocket/registry.ts`)
3. Each handler is a separate file in `apps/server/src/websocket/handlers/`
4. Server responses are three categories defined in `packages/shared/types/`:
   - **`WSBroadcast`**: Sent to all room clients (room events, scheduled actions, stream updates)
   - **`WSUnicast`**: Sent to a single client (NTP responses, search results)
   - **`WSResponse`**: Union of broadcast + unicast

Adding a new WebSocket message type requires: adding to `ClientActionEnum` in `packages/shared/types/WSRequest.ts`, creating a schema, adding a handler file, and registering it in the registry.

### Time Synchronization

NTP-inspired protocol for millisecond-accurate cross-device playback:
- Client sends `NTP_REQUEST` with `t0` → server stamps `t1`/`t2` → client receives at `t3`
- Exponential moving average smoothing (α=0.2) for RTT estimation
- Minimum 10 measurements before "synced" state
- Play/pause commands are **scheduled actions**: server broadcasts `serverTimeToExecute` and clients execute at that synchronized moment, using max client RTT to calculate delay

### Audio Pipeline

Three-step upload flow (client uploads directly to R2, no server bandwidth used):
1. `POST /upload/get-presigned-url` → server generates presigned R2 PUT URL
2. Client PUTs file directly to R2
3. `POST /upload/complete` → server adds to room's audio sources, broadcasts update

R2 key structure: `room-{roomId}/{sanitized-name}☆{timestamp}.{ext}`

Utilities: `apps/server/src/lib/r2.ts` (presigned URLs, public URLs, batch delete, orphan cleanup), `apps/server/src/utils/responses.ts` (CORS headers, error/success response helpers).

### Client State Management

Three Zustand stores in `apps/client/src/store/`:
- **`global.tsx`**: Main store (~1500 lines). Audio sources, WebSocket connection, NTP sync state, spatial audio, playback state, volume, search results, stream jobs. Uses LRU buffer cache (max 3 audio buffers).
- **`room.tsx`**: Room metadata (roomId, username, loading state)
- **`chat.tsx`**: Chat messages

HTTP data fetching uses Axios + TanStack React Query. WebSocket message utilities in `apps/client/src/utils/ws.ts`.

### Audio Loading Coordination

When play is requested, the server doesn't immediately schedule playback. Instead:
1. Server broadcasts `LOAD_AUDIO_SOURCE` to all clients
2. Clients load/decode the audio and respond with `AUDIO_SOURCE_LOADED`
3. Server waits for all clients (or 3s timeout) then schedules synchronized play

### Spatial Audio

Grid-based positioning system where clients are placed on a grid. A "listening source" position determines gain per client using distance calculations. Server broadcasts spatial gain config at 100ms intervals. Client applies: `effectiveGain = globalVolume × spatialGain`.

## Environment Setup

`apps/client/.env`:
```
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws
```

`apps/server/.env`:
```
S3_BUCKET_NAME=
S3_PUBLIC_URL=
S3_ENDPOINT=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
OPERATOR_SECRET=        # optional; enables /admin/* (fail-closed 404 when unset) and rooms:list/room:info --sync

# Music provider search/streaming (all optional; provider disabled without PROVIDER_URL)
PROVIDER_TYPE=          # qobuz (default) | navidrome
PROVIDER_URL=
NAVIDROME_USER=
NAVIDROME_PASSWORD=
NAVIDROME_STREAM_FORMAT=       # transcode target for streamed tracks; default mp3, "raw" = untouched original
NAVIDROME_STREAM_MAX_BITRATE=  # default 320; ignored when format is raw
```

## Deployment

- **Docker**: Multi-stage build with `oven/bun:1`. Exposes port 8080. Entry: `bun start`.
- **PM2**: Config in `pm2.config.js`. Process name: `beatsync-server`.
- Server has graceful shutdown (SIGTERM/SIGINT) that backs up state to R2 before exit.

## Development Notes

- No testing framework on the client; server uses `bun test` with sinon for stubs
- Server uses native `Bun.serve()` with URL pathname switch routing (not Hono's router)
- Room IDs are 6-digit codes
- **Rooms are permanent (non-demo).** Room state and uploaded R2 audio are NEVER auto-deleted — not on disconnect, not on restart, not by startup orphan-cleanup. On last disconnect the room releases per-room intervals and backs up, but stays resident. Persisted state (R2 backups, every 60s + on last disconnect) is authoritative and restored before the server accepts connections. Only the **demo** room (`IS_DEMO_MODE`) is ephemeral (60s cleanup + delete). Inspect persisted rooms offline with `bun run rooms:list` / `bun run room:info <id>` (they read the latest R2 backup; add `--sync` to have the running server write a fresh one first).
- **Deletion is operator-only, via the `/admin/*` API** (`OPERATOR_SECRET` bearer; fail-closed `404` when the secret is unset; see `OPERATOR_ROOM_MANAGEMENT.md` at the workspace root above this repo). **Archive** (`room:archive`) is the reversible first choice: clients evicted, room hidden from `/discover` and new joins rejected, but state + R2 audio kept (`archived` flag in the room backup). **Delete** (`room:delete <id> --yes`) evicts, purges `room-{id}` R2 objects, drops the room, and writes a tombstone (`operator/registry.json`, roomId → deletedAt) so restores from backups older than the deletion skip the room — while a room re-created later with the same id restores normally (restore compares the backup timestamp against deletedAt).
- **Admin is a recoverable per-room token**, not first-joiner-wins. The first connector to a brand-new room becomes admin and mints the token (handed to that client via `SET_ADMIN_TOKEN`, stored in `localStorage`, re-presented on connect as `?roomAdminToken=`). Anyone presenting the token becomes a co-curator; everyone else is a listener. No random promotion when an admin leaves. Recover a lost token server-side with `bun run room:admin-token <roomId>`.
