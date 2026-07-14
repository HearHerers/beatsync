// List all persisted rooms from the latest R2 state backup (offline — does not
// need the server to be running).
//
//   bun run rooms:list [--json] [--sync]
//
// One row per room: id, name, type, zones, tracks, chat messages, cached
// clients, admin-token presence. Data reflects the last backup (every 60s + on
// last disconnect), so it is at most ~60s stale while the server runs; pass
// --sync to have the running server write a fresh backup first (needs
// OPERATOR_SECRET in .env). See OPERATOR_ROOM_MANAGEMENT.md (project root) —
// this is Phase 0.

import { loadLatestBackup, requestSyncBackup, summarizeRoom } from "./lib/backupSnapshot";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main() {
  const json = process.argv.includes("--json");

  if (process.argv.includes("--sync")) {
    try {
      await requestSyncBackup();
    } catch (err) {
      console.error(`⚠️ Sync failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("   Reading the latest existing snapshot instead.\n");
    }
  }

  const { key, ageMinutes, backup } = await loadLatestBackup();
  const summaries = Object.entries(backup.data.rooms)
    .map(([roomId, room]) => summarizeRoom(roomId, room))
    .sort((a, b) => a.roomId.localeCompare(b.roomId));

  if (json) {
    console.log(JSON.stringify({ backupKey: key, backupAgeMinutes: ageMinutes, rooms: summaries }, null, 2));
    return;
  }

  console.log(`Latest backup: ${key} (~${ageMinutes}m old) — ${summaries.length} room(s)\n`);
  if (summaries.length === 0) return;

  const rows = summaries.map((s) => [
    s.roomId,
    s.roomName ?? "—",
    s.roomType,
    s.zoneCount === null ? "—" : String(s.zoneCount),
    String(s.trackCount),
    s.isPlaying ? "yes" : "no",
    String(s.chatMessageCount),
    String(s.cachedClientCount),
    s.hasAdminToken ? "yes" : "no",
  ]);
  const header = ["ROOM ID", "NAME", "TYPE", "ZONES", "TRACKS", "PLAYING", "CHAT", "CLIENTS*", "TOKEN"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));

  console.log(header.map((h, i) => pad(h, widths[i]!)).join("  "));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i]!)).join("  "));
  }
  console.log("\n* clients cached in the backup, not a live count.");
  console.log("Detail: bun run room:info <roomId>");
}

main().catch((err) => {
  console.error(`rooms:list failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
