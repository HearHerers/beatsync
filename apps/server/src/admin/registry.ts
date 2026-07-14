// Operator registry — a single small R2-resident JSON file holding tombstones
// for hard-deleted rooms (OPERATOR_ROOM_MANAGEMENT.md §4.3).
//
// A tombstone maps roomId -> deletedAt (epoch ms). Restore skips a room only
// when the backup being restored is OLDER than the deletion — that defeats
// resurrection from stale backups while still letting a legitimately
// re-created room (same 6-digit id, made after the delete) restore normally.
// Restore reads only the latest backup, so a permanent id-based skip would
// poison reused room ids forever.
//
// The `archived` flag deliberately does NOT live here — it rides the room's own
// backup (RoomBackupSchema.archived), which always exists for an archived room.
// Writes are infrequent (operator deletes only); read-modify-write with
// last-write-wins is fine at this scale.

import { z } from "zod";
import { downloadJSON, uploadJSON } from "@/lib/r2";

const REGISTRY_KEY = "operator/registry.json";

const RegistrySchema = z.object({
  tombstones: z.record(z.string(), z.number()).default({}),
});

// null = not loaded yet (treat as empty; loadRegistry runs before restore).
let tombstones: Map<string, number> | null = null;

export async function loadRegistry(): Promise<void> {
  try {
    const raw = await downloadJSON(REGISTRY_KEY);
    if (raw === null || raw === undefined) {
      tombstones = new Map();
      return;
    }
    const parsed = RegistrySchema.parse(raw);
    tombstones = new Map(Object.entries(parsed.tombstones));
    if (tombstones.size > 0) {
      console.log(`🪦 Operator registry loaded: ${tombstones.size} tombstone(s)`);
    }
  } catch (error) {
    // Fail open to an empty registry rather than blocking startup: the worst
    // case is a deleted room resurrecting, which the operator can re-delete.
    console.error("⚠️ Failed to load operator registry (continuing with none):", error);
    tombstones = new Map();
  }
}

/** Should a room in a backup written at `backupTimestamp` be skipped on restore? */
export function isTombstonedAt(roomId: string, backupTimestamp: number): boolean {
  const deletedAt = tombstones?.get(roomId);
  return deletedAt !== undefined && backupTimestamp <= deletedAt;
}

export async function addTombstone(roomId: string): Promise<void> {
  if (tombstones === null) await loadRegistry();
  tombstones!.set(roomId, Date.now());
  await uploadJSON(REGISTRY_KEY, RegistrySchema.parse({ tombstones: Object.fromEntries(tombstones!) }));
  console.log(`🪦 Tombstoned room ${roomId}`);
}

/** Test hook: force the next access to reload from R2. */
export function resetRegistryForTest(): void {
  tombstones = null;
}
