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
//
// Requires OPERATOR_SECRET in .env and the server running (SERVER_URL to
// override http://localhost:8080).

import { loadLatestBackup, operatorRequest, summarizeRoom } from "./lib/backupSnapshot";

const USAGE = "Usage: bun run scripts/room-manage.ts <archive|unarchive|delete> <roomId> [--yes]";

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const [action, roomId] = args.filter((a) => !a.startsWith("--"));
  if (!roomId || !action || !["archive", "unarchive", "delete"].includes(action)) {
    console.error(USAGE);
    process.exit(1);
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
