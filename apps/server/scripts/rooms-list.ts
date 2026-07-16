// List all persisted rooms from the latest R2 state backup (offline — does not
// need the server to be running).
//
//   bun run rooms:list [--json] [--sync] [--show-tokens]
//
// One row per room: id, name, type, zones, tracks, chat messages, cached
// clients, admin-token presence. Data reflects the last backup (every 60s + on
// last disconnect), so it is at most ~60s stale while the server runs; pass
// --sync to have the running server write a fresh backup first (needs
// OPERATOR_SECRET in .env). --show-tokens prints each room's admin token in
// full (present it on join as ?roomAdminToken=<token> to become co-curator) —
// redacted to yes/no by default since a token grants curator control of its
// room. See OPERATOR_ROOM_MANAGEMENT.md (project root) — this is Phase 0.

import { loadLatestBackup, requestSyncBackup, summarizeRoom } from "./lib/backupSnapshot";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main() {
  const json = process.argv.includes("--json");
  const showTokens = process.argv.includes("--show-tokens");

  if (process.argv.includes("--sync")) {
    try {
      await requestSyncBackup();
    } catch (err) {
      console.error(`⚠️ Sync failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("   Reading the latest existing snapshot instead.\n");
    }
  }

  const { key, ageMinutes, backup } = await loadLatestBackup();
  const entries = Object.entries(backup.data.rooms)
    .map(([roomId, room]) => ({
      summary: summarizeRoom(roomId, room),
      adminToken: room.adminToken ?? null,
    }))
    .sort((a, b) => a.summary.roomId.localeCompare(b.summary.roomId));
  const summaries = entries.map((e) => e.summary);

  if (json) {
    const rooms = entries.map((e) => (showTokens ? { ...e.summary, adminToken: e.adminToken } : e.summary));
    console.log(JSON.stringify({ backupKey: key, backupAgeMinutes: ageMinutes, rooms }, null, 2));
    return;
  }

  console.log(`Latest backup: ${key} (~${ageMinutes}m old) — ${summaries.length} room(s)\n`);
  if (summaries.length === 0) return;

  const rows = entries.map(({ summary: s, adminToken }) => [
    s.roomId,
    (s.roomName ?? "—") + (s.archived ? " [archived]" : ""),
    s.roomType,
    s.zoneCount === null ? "—" : String(s.zoneCount),
    String(s.trackCount),
    s.isPlaying ? "yes" : "no",
    String(s.chatMessageCount),
    String(s.cachedClientCount),
    showTokens ? (adminToken ?? "—") : s.hasAdminToken ? "yes" : "no",
  ]);
  const header = [
    "ROOM ID",
    "NAME",
    "TYPE",
    "ZONES",
    "TRACKS",
    "PLAYING",
    "CHAT",
    "CLIENTS*",
    showTokens ? "ADMIN TOKEN" : "TOKEN",
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));

  console.log(header.map((h, i) => pad(h, widths[i]!)).join("  "));
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i]!)).join("  "));
  }
  console.log("\n* clients cached in the backup, not a live count.");
  if (showTokens) {
    console.log("Join as co-curator: append ?roomAdminToken=<token> to the room URL.");
  } else {
    console.log("Tokens: rerun with --show-tokens to print them.");
  }
  console.log("Detail: bun run room:info <roomId>");
}

main().catch((err) => {
  console.error(`rooms:list failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
