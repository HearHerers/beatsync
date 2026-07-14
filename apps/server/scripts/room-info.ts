// Full detail for one persisted room, read offline from the latest R2 state
// backup (does not need the server to be running).
//
//   bun run room:info <roomId> [--json] [--show-token]
//
// Shows room name, type, zones (shape name/type/falloff joined to the playlist
// context whose id == shape.id) with their tracks, the room-wide "main"
// playlist, cached clients, and chat size. The admin token is redacted unless
// --show-token is passed. See OPERATOR_ROOM_MANAGEMENT.md (project root) —
// this is Phase 0.

import { MAIN_CONTEXT_ID, zoneDisplayName } from "@beatsync/shared";
import type { RoomBackupType } from "@/managers/RoomManager";
import { loadLatestBackup, trackTitleFromUrl } from "./lib/backupSnapshot";

type Playlist = RoomBackupType["playlists"][number];

function playlistLines(playlist: Playlist, indent: string): string[] {
  const { playbackState } = playlist;
  const status =
    playbackState.type === "playing"
      ? `playing (track ${playbackState.trackIndex + 1})`
      : "paused";
  const lines = [`${indent}${playlist.tracks.length} track(s), ${status}${playlist.loop ? ", loop" : ""}`];
  playlist.tracks.forEach((track, i) => {
    const marker = playbackState.type === "playing" && i === playbackState.trackIndex ? "▶" : " ";
    lines.push(`${indent}  ${marker} ${i + 1}. ${trackTitleFromUrl(track.url)}`);
  });
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const roomId = args.find((a) => !a.startsWith("--"));
  if (!roomId) {
    console.error("Usage: bun run room:info <roomId> [--json] [--show-token]");
    process.exit(1);
  }

  const { key, ageMinutes, backup } = await loadLatestBackup();
  const room = backup.data.rooms[roomId];
  if (!room) {
    const ids = Object.keys(backup.data.rooms);
    console.error(`Room "${roomId}" not found in latest backup. Known rooms: ${ids.join(", ") || "(none)"}`);
    process.exit(1);
  }

  const roomType = room.roomType ?? "audio";
  const shapes = room.shapes ?? [];
  const playlistsById = new Map(room.playlists.map((p) => [p.id, p]));
  const zoneContextIds = new Set(shapes.map((s) => s.id));
  const zones = shapes.map((shape) => ({
    id: shape.id,
    name: shape.name ?? null,
    displayName: zoneDisplayName(shape),
    type: shape.type,
    falloffMeters: shape.falloffMeters,
    groupId: shape.groupId,
    playlist: playlistsById.get(shape.id) ?? null,
  }));
  const mainPlaylist = playlistsById.get(MAIN_CONTEXT_ID) ?? null;
  // Playlist contexts that belong to neither a current zone nor the room-wide
  // "main" context (e.g. left behind by a deleted zone).
  const unattached = room.playlists.filter((p) => p.id !== MAIN_CONTEXT_ID && !zoneContextIds.has(p.id));

  if (flags.has("--json")) {
    console.log(
      JSON.stringify(
        {
          backupKey: key,
          backupAgeMinutes: ageMinutes,
          roomId,
          roomName: room.roomName ?? null,
          roomType,
          globalVolume: room.globalVolume,
          lowPassFreq: room.lowPassFreq,
          chatMessageCount: room.chat?.messages.length ?? 0,
          adminToken: flags.has("--show-token") ? (room.adminToken ?? null) : room.adminToken ? "<redacted>" : null,
          zones,
          mainPlaylist,
          unattachedPlaylists: unattached,
          cachedClients: room.clientDatas.map((c) => ({
            clientId: c.clientId,
            username: c.username,
            isAdmin: c.isAdmin,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  const title = room.roomName ? `"${room.roomName}"` : "(unnamed)";
  console.log(`Room ${roomId} — ${title} · ${roomType} room`);
  console.log(`Backup: ${key} (~${ageMinutes}m old)`);
  const token = room.adminToken
    ? flags.has("--show-token")
      ? room.adminToken
      : "present (--show-token to print)"
    : "none";
  console.log(
    `Volume ${Math.round(room.globalVolume * 100)}% · low-pass ${room.lowPassFreq} Hz · ` +
      `chat ${room.chat?.messages.length ?? 0} msg(s) · admin token: ${token}`
  );

  if (roomType === "map") {
    console.log(`\nZones (${zones.length}):`);
    for (const zone of zones) {
      const group = zone.groupId ? ` · group ${zone.groupId}` : "";
      console.log(`  ${zone.displayName} — ${zone.type}, falloff ${zone.falloffMeters} m${group} (id ${zone.id})`);
      if (zone.playlist) {
        for (const line of playlistLines(zone.playlist, "    ")) console.log(line);
      } else {
        console.log("    no playlist context");
      }
    }
  }

  if (mainPlaylist && (roomType === "audio" || mainPlaylist.tracks.length > 0)) {
    console.log(`\nRoom-wide playlist ("${MAIN_CONTEXT_ID}"):`);
    for (const line of playlistLines(mainPlaylist, "  ")) console.log(line);
  }

  if (unattached.length > 0) {
    console.log(`\nUnattached playlist contexts (${unattached.length}) — no matching zone:`);
    for (const playlist of unattached) {
      console.log(`  context ${playlist.id}:`);
      for (const line of playlistLines(playlist, "    ")) console.log(line);
    }
  }

  const clients = room.clientDatas.map((c) => `${c.username}${c.isAdmin ? " (admin)" : ""}`);
  console.log(`\nCached clients (${clients.length}): ${clients.join(", ") || "—"}`);
}

main().catch((err) => {
  console.error(`room:info failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
