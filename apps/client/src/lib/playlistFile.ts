// Import/export of a playlist context (a map-room zone or the audio-room main
// queue) as a portable JSON file. Tracks travel as URLs; the server resolves
// each on import (same-room reference, same-bucket copy, or foreign reference).

import { extractFileNameFromUrl } from "@/lib/utils";
import {
  PLAYLIST_EXPORT_VERSION,
  PlaylistExportSchema,
  type PlaylistExportType,
  type PlaylistType,
} from "@beatsync/shared";

/** Build the export document for a playlist context. */
export function buildPlaylistExport(
  playlist: PlaylistType,
  opts: { roomId: string; label?: string }
): PlaylistExportType {
  return {
    beatsyncPlaylist: PLAYLIST_EXPORT_VERSION,
    name: opts.label,
    loop: playlist.loop,
    exportedAt: Date.now(),
    sourceRoomId: opts.roomId,
    tracks: playlist.tracks.map((t) => ({
      url: t.url,
      name: safeName(t.url),
    })),
  };
}

function safeName(url: string): string | undefined {
  try {
    return extractFileNameFromUrl(url);
  } catch {
    return undefined;
  }
}

/** Serialize a playlist to JSON and trigger a browser download. */
export function exportPlaylistToFile(playlist: PlaylistType, opts: { roomId: string; label?: string }): void {
  const doc = buildPlaylistExport(playlist, opts);
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(opts.label ?? "playlist").replace(/[^a-z0-9_-]+/gi, "-")}.hearhere.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Read + validate an imported playlist file. Throws (with a human-readable
 * message) on malformed JSON or a schema mismatch.
 */
export async function parsePlaylistFile(file: File): Promise<PlaylistExportType> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  const result = PlaylistExportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("Not a valid playlist file (unexpected format).");
  }
  return result.data;
}
