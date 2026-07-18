// Operator room mutations — thin client of the running server's /admin API
// (the server is the single implementation; see src/routes/admin.ts and
// OPERATOR_ROOM_MANAGEMENT.md at the workspace root).
//
//   bun run room:archive <roomId>     — soft delete: evict + hide + reject joins;
//                                       state and R2 audio kept, reversible
//   bun run room:unarchive <roomId>   — reverse an archive
//   bun run room:delete <roomId> --yes — HARD delete: evict, purge R2 audio,
//                                       tombstone. Irreversible. Without --yes
//                                       it prints what would be deleted and exits.
//   bun run rooms:purge --yes         — HARD delete EVERY room (state + all R2
//                                       audio, including orphans). Irreversible.
//   bun run room:duplicate <roomId> [newId] — structure-only copy (type, map
//                                       config, shapes, name) into newId (random
//                                       6-digit id when omitted). No playlists/
//                                       audio, no chat; first joiner of the copy
//                                       mints a fresh admin token.
//
// Requires OPERATOR_SECRET in .env and the server running (SERVER_URL to
// override http://localhost:8080).

import { loadLatestBackup, operatorRequest, summarizeRoom } from "./lib/backupSnapshot";

const USAGE =
  "Usage: bun run scripts/room-manage.ts <archive|unarchive|delete> <roomId> [--yes] | duplicate <roomId> [newId] | purge [--yes]";

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const [action, roomId, targetId] = args.filter((a) => !a.startsWith("--"));

  if (action === "purge") {
    if (!yes) {
      try {
        const { backup, ageMinutes } = await loadLatestBackup();
        const rooms = Object.entries(backup.data.rooms).map(([id, r]) => summarizeRoom(id, r));
        const tracks = rooms.reduce((n, r) => n + r.trackCount, 0);
        console.log(`Latest snapshot (~${ageMinutes}m old): ${rooms.length} room(s), ${tracks} track(s) total.`);
        for (const r of rooms) console.log(`  ${r.roomId}  ${r.roomName ?? "—"}  (${r.trackCount} tracks)`);
      } catch (err) {
        console.log(`(Could not load snapshot for preview: ${err instanceof Error ? err.message : String(err)})`);
      }
      console.log(`\nPurging is IRREVERSIBLE: EVERY room's state and ALL uploaded audio are wiped,`);
      console.log(`including orphaned audio, and all rooms are tombstoned.`);
      console.log(`To proceed: bun run rooms:purge --yes`);
      process.exit(1);
    }
    const result = await operatorRequest("/admin/rooms?confirm=all", "DELETE");
    console.log(`purge ok: ${JSON.stringify(result)}`);
    return;
  }

  if (!roomId || !action || !["archive", "unarchive", "delete", "duplicate"].includes(action)) {
    console.error(USAGE);
    process.exit(1);
  }

  if (action === "duplicate") {
    const path = `/admin/rooms/${roomId}/duplicate${targetId ? `?to=${encodeURIComponent(targetId)}` : ""}`;
    const result = await operatorRequest(path, "POST");
    console.log(`duplicate ok: ${JSON.stringify(result)}`);
    return;
  }

  if (action === "delete" && !yes) {
    // Show what's at stake before an irreversible delete.
    try {
      const { backup, ageMinutes } = await loadLatestBackup();
      const room = backup.data.rooms[roomId];
      if (room) {
        const s = summarizeRoom(roomId, room);
        console.log(`Room ${s.roomId} — ${s.roomName ?? "(unnamed)"} · ${s.roomType} room (snapshot ~${ageMinutes}m old)`);
        console.log(
          `  ${s.zoneCount ?? 0} zone(s), ${s.trackCount} track(s), ${s.chatMessageCount} chat message(s)`
        );
      } else {
        console.log(`Room ${roomId} is not in the latest backup snapshot.`);
      }
    } catch (err) {
      console.log(`(Could not load snapshot for preview: ${err instanceof Error ? err.message : String(err)})`);
    }
    console.log(`\nDeleting is IRREVERSIBLE: room state and all uploaded audio are purged,`);
    console.log(`and a tombstone prevents any backup from restoring it.`);
    console.log(`To proceed: bun run room:delete ${roomId} --yes`);
    console.log(`(Consider "bun run room:archive ${roomId}" instead — it's reversible.)`);
    process.exit(1);
  }

  const result =
    action === "delete"
      ? await operatorRequest(`/admin/rooms/${roomId}`, "DELETE")
      : await operatorRequest(`/admin/rooms/${roomId}/${action}`, "POST");

  console.log(`${action} ok: ${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(`room-manage failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
