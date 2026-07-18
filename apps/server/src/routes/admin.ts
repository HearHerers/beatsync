// Operator sub-router for /admin/*. Fail-closed: unauthorized requests get a
// bare 404 so the surface is invisible without the secret
// (see OPERATOR_ROOM_MANAGEMENT.md §4.1, workspace root above this repo).
//
// Deliberately no CORS headers here (unlike jsonResponse/errorResponse):
// operator calls are same-origin or non-browser clients sending the bearer.
//
// Endpoints:
//
//   POST   /admin/backup                 — write a fresh state backup to R2 now
//                                          (powers `rooms:list --sync`)
//   POST   /admin/beatgrids/reload       — re-read REKORDBOX_BEATGRIDS_PATH,
//                                          backfill grids onto resident rooms'
//                                          tracks, notify changed rooms (the
//                                          sync pipeline's last step — see
//                                          rekordbox-integration/post_sync.sh)
//   POST   /admin/rooms/:id/archive      — soft delete: evict clients, hide from
//                                          discovery, reject joins; state + R2
//                                          audio kept, reversible
//   POST   /admin/rooms/:id/unarchive    — reverse an archive
//   POST   /admin/rooms/:id/duplicate    — copy the room's structure (type, map
//                                          config, shapes, name) into a new room
//                                          id (?to=<id>, else random 6-digit).
//                                          No playlists/audio, no chat, no admin
//                                          token — the first joiner of the copy
//                                          mints a fresh one
//   DELETE /admin/rooms/:id              — hard delete: evict, purge R2 audio,
//                                          drop from memory, tombstone so no
//                                          older backup can resurrect it
//
// Every mutation is followed by a state backup so the latest snapshot reflects
// the operator action immediately.

import { isOperator } from "@/admin/auth";
import { addTombstone, addTombstones } from "@/admin/registry";
import { IS_DEMO_MODE } from "@/demo";
import { deleteObjectsWithPrefix } from "@/lib/r2";
import { BackupManager } from "@/managers/BackupManager";
import { reloadBeatgridIndex } from "@/managers/BeatgridIndex";
import { globalManager } from "@/managers";
import type { BunServer } from "@/utils/websocket";
import type { WSBroadcastType } from "@beatsync/shared";

const invisible = () => new Response("Not found", { status: 404 });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

async function backupNow(): Promise<void> {
  await BackupManager.backupState();
}

export async function handleAdmin(req: Request, url: URL, server?: BunServer): Promise<Response> {
  if (IS_DEMO_MODE || !isOperator(req)) return invisible();

  if (req.method === "POST" && url.pathname === "/admin/backup") {
    await backupNow();
    let rooms = 0;
    globalManager.forEachRoom(() => rooms++);
    console.log(`🛠️ Operator triggered an on-demand state backup (${rooms} room(s)).`);
    return json({ ok: true, rooms });
  }

  // Reload the Rekordbox beatgrid index and reconcile every resident room's
  // tracks against it (attach missing grids, correct stale "auto" grids;
  // manual grids untouched). On a failed load the previous index stays active.
  if (req.method === "POST" && url.pathname === "/admin/beatgrids/reload") {
    const result = reloadBeatgridIndex();
    if (!result.ok) {
      console.warn(`🛠️ Operator beatgrid reload failed: ${result.error}`);
      return json({ ok: false, error: result.error }, 400);
    }
    const changedRooms: Record<string, number> = {};
    let changedTracks = 0;
    globalManager.forEachRoom((room, roomId) => {
      const n = room.backfillBeatgrids();
      if (n === 0) return;
      changedRooms[roomId] = n;
      changedTracks += n;
      // Mirror the new grids into connected clients' playlist views. Publish
      // on the injected server directly (sendBroadcast is exactly this) so the
      // route depends only on its own arguments.
      if (server) {
        const message: WSBroadcastType = {
          type: "ROOM_EVENT",
          event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
        };
        server.publish(roomId, JSON.stringify(message));
      }
    });
    // Grids live in playlist state; snapshot so the change survives a crash.
    if (changedTracks > 0) await backupNow();
    console.log(
      `🛠️ Operator reloaded beatgrids (${result.index.tracks} track(s) in index; ` +
        `${changedTracks} track entr(ies) updated across ${Object.keys(changedRooms).length} room(s)).`
    );
    return json({
      ok: true,
      indexTracks: result.index.tracks,
      skippedDynamic: result.index.skippedDynamic,
      ambiguousKeys: result.index.ambiguousKeys,
      changedTracks,
      changedRooms,
    });
  }

  // Purge: wipe EVERY room — state, R2 audio (including orphaned room-* audio
  // with no resident room), tombstones for all resident ids, then a fresh empty
  // backup. Requires an explicit ?confirm=all so a stray collection-DELETE
  // can't nuke the server.
  if (req.method === "DELETE" && url.pathname === "/admin/rooms") {
    if (url.searchParams.get("confirm") !== "all") {
      return json({ ok: false, error: "Purge requires ?confirm=all" }, 400);
    }
    const roomIds: string[] = [];
    globalManager.forEachRoom((_room, id) => roomIds.push(id));
    for (const id of roomIds) {
      const r = globalManager.getRoom(id);
      if (!r) continue;
      r.evictAllClients("Room purged by operator");
      await r.cleanup(); // stops intervals + deletes R2 `room-{id}` objects
      globalManager.deleteRoom(id);
    }
    // Sweep orphaned audio from rooms that were not resident.
    const { deletedCount } = await deleteObjectsWithPrefix("room-");
    await addTombstones(roomIds);
    await backupNow();
    console.log(`🛠️ Operator purged ALL rooms (${roomIds.length} resident, ${deletedCount} orphaned R2 objects swept)`);
    return json({ ok: true, purgedRooms: roomIds.length, orphanedObjectsDeleted: deletedCount });
  }

  // /admin/rooms/:id[/action] — room ids are simple tokens (6-digit codes);
  // reject anything path-unsafe rather than trying to be clever.
  const roomMatch = /^\/admin\/rooms\/([A-Za-z0-9_-]+)(?:\/(archive|unarchive))?$/.exec(url.pathname);
  if (!roomMatch) return invisible();
  const [, roomId, action] = roomMatch;
  const room = globalManager.getRoom(roomId);

  if (req.method === "DELETE" && !action) {
    // Order matters (OPERATOR_ROOM_MANAGEMENT.md §4.4): evict + release, purge
    // R2 audio, drop from memory, tombstone, then backup so the latest snapshot
    // no longer lists the room. The tombstone covers crash-before-backup and
    // restores from older snapshots.
    if (room) {
      room.evictAllClients("Room deleted by operator");
      await room.cleanup(); // stops intervals + deletes R2 `room-{id}` objects
      globalManager.deleteRoom(roomId);
    } else {
      // Not resident (shouldn't happen for non-demo rooms, but be thorough):
      // still purge any R2 audio and tombstone so old backups can't revive it.
      await deleteObjectsWithPrefix(`room-${roomId}`);
    }
    await addTombstone(roomId);
    await backupNow();
    console.log(`🛠️ Operator deleted room ${roomId}${room ? "" : " (was not resident)"}`);
    return json({ ok: true, roomId, deleted: true, wasResident: Boolean(room) });
  }

  if (req.method === "POST" && (action === "archive" || action === "unarchive")) {
    if (!room) return json({ ok: false, error: `Room ${roomId} not found` }, 404);
    const archiving = action === "archive";
    room.setArchived(archiving);
    if (archiving) room.evictAllClients("Room archived by operator");
    await backupNow();
    console.log(`🛠️ Operator ${action}d room ${roomId}`);
    return json({ ok: true, roomId, archived: archiving });
  }

  return invisible();
}
