// Whole-room export / import (#70). Captures a map room's structure — zones
// (geometry + falloff + name), each context's playlist (as track URL refs), and
// room settings (name, default map view, base layer) — as a portable JSON file.
//
// SAME-SERVER assumption: tracks travel as URLs, not audio blobs. Re-importing
// on the same deployment resolves those URLs; IMPORT_TRACKS_TO_CONTEXT copies
// bucket-local files and references foreign ones (see the server handler). We do
// NOT bundle audio.

import type { MapMetadataType, MapTileLayerId, ShapeType } from "@beatsync/shared";

export const ROOM_EXPORT_VERSION = 1;

export interface RoomPlaylistExport {
  /** "main" (the pool) or a shape id. */
  contextId: string;
  loop: boolean;
  /** Track URLs in playlist order. */
  urls: string[];
}

export interface RoomExportDoc {
  hearhereRoom: number; // version discriminator
  exportedAt?: number;
  sourceRoomId?: string;
  roomName?: string;
  mapMetadata?: MapMetadataType;
  defaultTileLayerId?: MapTileLayerId;
  shapes: ShapeType[];
  playlists: RoomPlaylistExport[];
}

export function buildRoomExport(input: {
  sourceRoomId?: string;
  roomName?: string;
  mapMetadata?: MapMetadataType;
  defaultTileLayerId?: MapTileLayerId;
  shapes: ShapeType[];
  playlists: RoomPlaylistExport[];
  now: number; // pass Date.now() from the caller (keeps this pure/testable)
}): RoomExportDoc {
  return {
    hearhereRoom: ROOM_EXPORT_VERSION,
    exportedAt: input.now,
    sourceRoomId: input.sourceRoomId,
    roomName: input.roomName,
    mapMetadata: input.mapMetadata,
    defaultTileLayerId: input.defaultTileLayerId,
    shapes: input.shapes,
    // Drop empty playlists — nothing to import, and the server rejects an empty
    // urls array anyway.
    playlists: input.playlists.filter((p) => p.urls.length > 0 || p.loop),
  };
}

export function downloadRoomFile(doc: RoomExportDoc, label: string): void {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${label.replace(/[^a-z0-9_-]+/gi, "-")}.hearhere-room.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function parseRoomFile(file: File): Promise<RoomExportDoc> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const doc = parsed as Partial<RoomExportDoc>;
  if (!doc || doc.hearhereRoom !== ROOM_EXPORT_VERSION) {
    throw new Error("Not a HearHere room file (unexpected format).");
  }
  if (!Array.isArray(doc.shapes) || !Array.isArray(doc.playlists)) {
    throw new Error("Room file is missing shapes or playlists.");
  }
  return doc as RoomExportDoc;
}
