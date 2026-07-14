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
//   POST   /admin/rooms/:id/archive      — soft delete: evict clients, hide from
//                                          discovery, reject joins; state + R2
//                                          audio kept, reversible
//   POST   /admin/rooms/:id/unarchive    — reverse an archive
//   DELETE /admin/rooms/:id              — hard delete: evict, purge R2 audio,
//                                          drop from memory, tombstone so no
//                                          older backup can resurrect it
//
// Every mutation is followed by a state backup so the latest snapshot reflects
// the operator action immediately.

import { isOperator } from "@/admin/auth";
import { addTombstone } from "@/admin/registry";
import { IS_DEMO_MODE } from "@/demo";
import { deleteObjectsWithPrefix } from "@/lib/r2";
import { BackupManager } from "@/managers/BackupManager";
import { globalManager } from "@/managers";

const invisible = () => new Response("Not found", { status: 404 });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

async function backupNow(): Promise<void> {
  await BackupManager.backupState();
}

export async function handleAdmin(req: Request, url: URL): Promise<Response> {
  if (IS_DEMO_MODE || !isOperator(req)) return invisible();

  if (req.method === "POST" && url.pathname === "/admin/backup") {
    await backupNow();
    let rooms = 0;
    globalManager.forEachRoom(() => rooms++);
    console.log(`🛠️ Operator triggered an on-demand state backup (${rooms} room(s)).`);
    return json({ ok: true, rooms });
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
