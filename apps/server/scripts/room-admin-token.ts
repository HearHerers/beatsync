// Recover a room's admin token from the latest R2 state backup.
//
//   bun run room:admin-token <roomId>
//
// Admin is a recoverable per-room token (see RoomManager.addClient). The live
// token lives in the running server's memory; this reads the most recent backup
// snapshot on R2, so it reflects state as of the last backup (every 60s + on
// last disconnect). Paste the printed token into the room URL as
// `?roomAdminToken=<token>` (or the in-app "use admin token" field) to claim
// admin on any device.

import { downloadJSON, getLatestFileWithPrefix, validateR2Config } from "@/lib/r2";
import { ServerBackupSchema } from "@/managers/RoomManager";

const BACKUP_PREFIX = "state-backup/";

async function main() {
  const roomId = process.argv[2];
  if (!roomId) {
    console.error("Usage: bun run room:admin-token <roomId>");
    process.exit(1);
  }

  const r2 = validateR2Config();
  if (!r2.isValid) {
    console.error(`R2 is not configured (missing: ${r2.errors.join(", ")}). Cannot read backups.`);
    process.exit(1);
  }

  const latestKey = await getLatestFileWithPrefix(BACKUP_PREFIX);
  if (!latestKey) {
    console.error("No state backups found on R2.");
    process.exit(1);
  }

  const raw = await downloadJSON(latestKey);
  const parsed = ServerBackupSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`Latest backup (${latestKey}) failed to parse: ${parsed.error.message}`);
    process.exit(1);
  }

  const room = parsed.data.data.rooms[roomId];
  if (!room) {
    const ids = Object.keys(parsed.data.data.rooms);
    console.error(`Room "${roomId}" not found in latest backup. Known rooms: ${ids.join(", ") || "(none)"}`);
    process.exit(1);
  }

  if (!room.adminToken) {
    console.error(`Room "${roomId}" has no admin token in the latest backup (older room or audio-only legacy state).`);
    process.exit(1);
  }

  const ageMin = Math.floor((Date.now() - parsed.data.timestamp) / 60000);
  console.log(`Room ${roomId} admin token (from backup ~${ageMin}m old):`);
  console.log(room.adminToken);
}

main().catch((err) => {
  console.error(`Failed to read admin token: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
