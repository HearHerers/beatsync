// Shared loader for operator CLI scripts (rooms-list, room-info) that read room
// state offline from the latest R2 state backup — the same source
// room-admin-token.ts uses. The snapshot is at most ~60s stale while the server
// runs (periodic backup interval + backup on last disconnect) and exact when the
// server is stopped.

import { downloadJSON, getLatestFileWithPrefix, validateR2Config } from "@/lib/r2";
import type { RoomBackupType, ServerBackupType } from "@/managers/RoomManager";
import { ServerBackupSchema } from "@/managers/RoomManager";

const BACKUP_PREFIX = "state-backup/";

export interface BackupSnapshot {
  key: string;
  ageMinutes: number;
  backup: ServerBackupType;
}

// Call the running server's operator API (/admin/*) with the OPERATOR_SECRET
// bearer. Requires OPERATOR_SECRET in the environment — apps/server/.env is
// shared between the server and these scripts — and the server to be reachable
// at SERVER_URL (default http://localhost:8080).
export async function operatorRequest(path: string, method: "POST" | "DELETE" = "POST"): Promise<unknown> {
  const secret = process.env.OPERATOR_SECRET ?? "";
  if (!secret) {
    throw new Error("OPERATOR_SECRET is not set. Add it to apps/server/.env (server and scripts share it).");
  }
  const base = (process.env.SERVER_URL ?? "http://localhost:8080").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}` },
    });
  } catch (err) {
    throw new Error(`Could not reach ${base} (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${base}${path} returned ${res.status}${body ? ` (${body})` : ""}. ` +
        "Is the server running with the same OPERATOR_SECRET?"
    );
  }
  return res.json();
}

// Ask the running server to write a fresh backup right now, so the snapshot we
// then read reflects current state instead of being up to ~60s stale.
export async function requestSyncBackup(): Promise<void> {
  await operatorRequest("/admin/backup");
}

export async function loadLatestBackup(): Promise<BackupSnapshot> {
  const r2 = validateR2Config();
  if (!r2.isValid) {
    throw new Error(`R2 is not configured (missing: ${r2.errors.join(", ")}). Cannot read backups.`);
  }

  const key = await getLatestFileWithPrefix(BACKUP_PREFIX);
  if (!key) {
    throw new Error("No state backups found on R2.");
  }

  const raw = await downloadJSON(key);
  const parsed = ServerBackupSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Latest backup (${key}) failed to parse: ${parsed.error.message}`);
  }

  return {
    key,
    ageMinutes: Math.floor((Date.now() - parsed.data.timestamp) / 60000),
    backup: parsed.data,
  };
}

// R2 keys look like `room-{roomId}/{sanitized-name}☆{timestamp}.{ext}`; derive a
// human-readable track title from the URL by taking the basename and stripping
// the ☆-timestamp uniquifier.
export function trackTitleFromUrl(url: string): string {
  const path = url.split("?")[0] ?? url;
  const basename = path.split("/").pop() ?? path;
  let decoded = basename;
  try {
    decoded = decodeURIComponent(basename);
  } catch {
    // keep the raw basename if the URL contains invalid escapes
  }
  return decoded.replace(/☆\d+(?=\.[^.]+$)/, "");
}

export interface RoomSummary {
  roomId: string;
  roomName: string | null;
  roomType: "audio" | "map";
  zoneCount: number | null; // null for audio rooms
  trackCount: number;
  isPlaying: boolean;
  chatMessageCount: number;
  cachedClientCount: number;
  hasAdminToken: boolean;
  archived: boolean;
}

export function summarizeRoom(roomId: string, room: RoomBackupType): RoomSummary {
  const roomType = room.roomType ?? "audio";
  return {
    roomId,
    roomName: room.roomName ?? null,
    roomType,
    zoneCount: roomType === "map" ? (room.shapes?.length ?? 0) : null,
    trackCount: room.playlists.reduce((n, p) => n + p.tracks.length, 0),
    isPlaying: room.playlists.some((p) => p.playbackState.type === "playing"),
    chatMessageCount: room.chat?.messages.length ?? 0,
    cachedClientCount: room.clientDatas.length,
    hasAdminToken: Boolean(room.adminToken),
    archived: room.archived ?? false,
  };
}
