"use client";
// Per-shape playlist column for the map dashboard. Sits next to the map in the
// center area and renders the SAME Queue/Uploader components audio rooms use,
// scoped to the currently-selected shape's playlist context (contextId = shape.id).
//
// What lives here:
//   - Header with shape title, loop toggle, delete-shape button
//   - AudioUploaderMinimal pinned ABOVE the queue (contextId-scoped upload)
//   - Queue, parameterized by contextId == shape.id
//
// What does NOT live here:
//   - Map rendering — MapCanvas
//   - Ensemble play/pause — EnsembleControls in the bottom bar
//   - Chat / user list — those still live in Right / Left

import { AudioUploaderMinimal } from "@/components/AudioUploaderMinimal";
import { InlineSearch } from "@/components/dashboard/InlineSearch";
import { Queue } from "@/components/Queue";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { matchBeatgridsToTracks, parseBeatgridFile } from "@/lib/beatgridFile";
import { exportPlaylistToFile, parsePlaylistFile } from "@/lib/playlistFile";
import { zoneDisplayName } from "@/lib/zoneName";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { useRoomStore } from "@/store/room";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum, MAP_CONSTANTS } from "@beatsync/shared";
import { Download, Music2, Repeat, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

interface MapShapePanelProps {
  canMutate: boolean;
}

export const MapShapePanel = ({ canMutate }: MapShapePanelProps) => {
  const shapes = useMapStore((s) => s.shapes);
  const selectedShapeId = useMapStore((s) => s.selectedShapeId);
  const playlist = useGlobalStore((s) => (selectedShapeId ? s.playlists.get(selectedShapeId) : undefined));
  const playlists = useGlobalStore((s) => s.playlists);
  const isConnected = useGlobalStore((s) => s.socket?.readyState === WebSocket.OPEN);
  const roomId = useRoomStore((s) => s.roomId);
  const importInputRef = useRef<HTMLInputElement>(null);
  const beatgridInputRef = useRef<HTMLInputElement>(null);

  const shape = selectedShapeId ? shapes.get(selectedShapeId) : undefined;

  // Local slider value (uncontrolled wrt server). Snaps to the shape's server-
  // side falloff when the selection changes or the server pushes an update;
  // outgoing changes commit only on release (onValueCommit) so we don't spam
  // SET_SHAPE_FALLOFF during a drag.
  const serverFalloffKey = shape ? `${shape.id}:${shape.falloffMeters}` : "";
  const [falloffDraft, setFalloffDraft] = useState<number>(
    shape?.falloffMeters ?? MAP_CONSTANTS.DEFAULT_FALLOFF_METERS
  );
  const [knownKey, setKnownKey] = useState<string>(serverFalloffKey);
  // Sync local draft to server value during render whenever the selection or
  // server-side falloff changes (the recommended pattern over useEffect+setState).
  if (serverFalloffKey !== knownKey) {
    setKnownKey(serverFalloffKey);
    setFalloffDraft(shape?.falloffMeters ?? MAP_CONSTANTS.DEFAULT_FALLOFF_METERS);
  }

  if (!shape) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-neutral-500">
        <div>Select a zone on the map to edit its playlist.</div>
        {shapes.size === 0 && canMutate && (
          <div className="text-neutral-600">Draw one with the toolbar in the top-left of the map.</div>
        )}
      </div>
    );
  }

  const send = (req: Parameters<typeof sendWSRequest>[0]["request"]) => {
    const socket = useGlobalStore.getState().socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    sendWSRequest({ ws: socket, request: req });
  };

  const handleExport = () => {
    if (!playlist || playlist.tracks.length === 0) {
      toast.error("This zone has no tracks to export.");
      return;
    }
    exportPlaylistToFile(playlist, { roomId, label: `zone-${shape.id.slice(0, 6)}` });
  };

  const handleImportFile = async (file: File) => {
    try {
      const doc = await parsePlaylistFile(file);
      const urls = doc.tracks.map((t) => t.url);
      if (urls.length === 0) {
        toast.error("That playlist file has no tracks.");
        return;
      }
      send({ type: ClientActionEnum.enum.IMPORT_TRACKS_TO_CONTEXT, contextId: shape.id, urls });
      toast.success(`Importing ${urls.length} track${urls.length === 1 ? "" : "s"}…`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import that file.");
    }
  };

  // Beatgrid import matches against EVERY track in the room (grids are a
  // property of the audio file, not of one zone), so importing once covers
  // all zones playing that track.
  const handleImportBeatgrids = async (file: File) => {
    try {
      const doc = await parseBeatgridFile(file);
      const allUrls = Array.from(new Set(Array.from(playlists.values()).flatMap((p) => p.tracks.map((t) => t.url))));
      const { matches, matchedByMetadata, unmatchedFiles, skippedDynamic } = matchBeatgridsToTracks(doc, allUrls);
      for (const m of matches) {
        send({ type: ClientActionEnum.enum.SET_TRACK_BEATGRID, url: m.url, beatgrid: m.beatgrid });
      }
      if (matches.length === 0) {
        toast.error("No beatgrids matched tracks in this room (matching is by filename or title/artist).");
      } else {
        toast.success(
          `Beatgrids: matched ${matches.length} of ${doc.tracks.length}` +
            (matchedByMetadata > 0 ? ` (${matchedByMetadata} via title/artist)` : "") +
            (skippedDynamic.length > 0 ? ` (${skippedDynamic.length} dynamic skipped)` : "")
        );
      }
      if (unmatchedFiles.length > 0) {
        console.log("[beatgrids] unmatched files:", unmatchedFiles);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import that file.");
    }
  };

  // Beat-sync state for the selected zone. A zone is a sync candidate (master)
  // when it's playing a gridded track and isn't the selected zone itself.
  const playingTrack = playlist?.playbackState.audioSource
    ? playlist.tracks.find((t) => t.url === playlist.playbackState.audioSource)
    : undefined;
  const playbackRate = playlist?.playbackState.playbackRate ?? 1;
  const isZonePlaying = playlist?.playbackState.type === "playing";
  const syncCandidates = Array.from(playlists.values())
    .filter((p) => p.id !== shape.id && shapes.has(p.id) && p.playbackState.type === "playing")
    .map((p) => ({
      contextId: p.id,
      beatgrid: p.tracks.find((t) => t.url === p.playbackState.audioSource)?.beatgrid,
    }));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <ShapeNameEditor shape={shape} canMutate={canMutate} send={send} />
          <div className="text-[11px] text-neutral-500">{shape.type}</div>
        </div>
        {canMutate && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={`h-7 px-1.5 ${playlist?.loop ? "text-green-400" : "text-neutral-500"}`}
              title={playlist?.loop ? "Looping zone" : "Not looping"}
              disabled={!isConnected}
              onClick={() =>
                send({
                  type: ClientActionEnum.enum.SET_CONTEXT_LOOP,
                  contextId: shape.id,
                  loop: !playlist?.loop,
                })
              }
            >
              <Repeat className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-1.5 text-neutral-500 hover:text-neutral-200"
              title="Export this zone's playlist"
              disabled={!playlist || playlist.tracks.length === 0}
              onClick={handleExport}
            >
              <Download className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-1.5 text-neutral-500 hover:text-neutral-200"
              title="Import a playlist into this zone"
              disabled={!isConnected}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload className="size-3.5" />
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // allow re-importing the same file
                if (file) void handleImportFile(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-1.5 text-neutral-500 hover:text-neutral-200"
              title="Import beatgrids (extract_beatgrids.py JSON) — matches every track in the room"
              disabled={!isConnected}
              onClick={() => beatgridInputRef.current?.click()}
            >
              <Music2 className="size-3.5" />
            </Button>
            <input
              ref={beatgridInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // allow re-importing the same file
                if (file) void handleImportBeatgrids(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-1.5 text-neutral-500 hover:text-red-400"
              title="Delete zone"
              disabled={!isConnected}
              onClick={() => send({ type: ClientActionEnum.enum.DELETE_SHAPE, shapeId: shape.id })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Edge-falloff slider — gain stays 1.0 inside the zone and fades to 0
          across this distance past the boundary. */}
      <div className="border-b border-neutral-800/50 px-4 py-2.5">
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-neutral-400">Edge falloff</span>
          <span className="font-mono text-neutral-300">{falloffDraft}m</span>
        </div>
        <Slider
          value={[falloffDraft]}
          min={MAP_CONSTANTS.MIN_FALLOFF_METERS}
          max={Math.max(200, MAP_CONSTANTS.MIN_FALLOFF_METERS + 1)}
          step={1}
          disabled={!canMutate || !isConnected}
          onValueChange={(v) => setFalloffDraft(v[0])}
          onValueCommit={(v) =>
            send({
              type: ClientActionEnum.enum.SET_SHAPE_FALLOFF,
              shapeId: shape.id,
              falloffMeters: v[0],
            })
          }
        />
        <div className="mt-1 text-[10px] text-neutral-500">
          Inside the zone: full volume. Outside: fades over {falloffDraft}m.
        </div>
      </div>

      {/* Beat sync — tempo-match this zone's playing track to another playing
          zone (CDJ-style one-shot sync). Needs beatgrids on both tracks. */}
      {canMutate && isZonePlaying && (
        <div className="border-b border-neutral-800/50 px-4 py-2.5">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-neutral-400">Beat sync</span>
            <span className="font-mono text-neutral-300">
              {playingTrack?.beatgrid ? `${playingTrack.beatgrid.bpm} BPM` : "no grid"}
              {playbackRate !== 1 && (
                <span className="ml-1.5 rounded bg-green-950 px-1 py-0.5 text-green-400">
                  ×{playbackRate.toFixed(3)}
                </span>
              )}
            </span>
          </div>
          {!playingTrack?.beatgrid ? (
            <div className="text-[10px] text-neutral-500">
              Import beatgrids (♫ button above) to enable sync for this track.
            </div>
          ) : syncCandidates.length === 0 ? (
            <div className="text-[10px] text-neutral-500">No other zone is playing to sync with.</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {syncCandidates.map((c) => (
                <Button
                  key={c.contextId}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  disabled={!isConnected || !c.beatgrid}
                  title={
                    c.beatgrid
                      ? `Beat-match this zone to ${c.contextId.slice(0, 6)} (${c.beatgrid.bpm} BPM)`
                      : `Zone ${c.contextId.slice(0, 6)}'s playing track has no beatgrid`
                  }
                  onClick={() =>
                    send({
                      type: ClientActionEnum.enum.SYNC_ZONES,
                      masterContextId: c.contextId,
                      followerContextId: shape.id,
                    })
                  }
                >
                  Sync to {c.contextId.slice(0, 6)}
                  {c.beatgrid ? ` · ${c.beatgrid.bpm}` : ""}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Provider search + uploader pinned above the queue. Search streams the
          chosen track straight into this zone's playlist (contextId). */}
      {canMutate && (
        <div className="flex flex-col gap-2 px-3 pt-3">
          <InlineSearch contextId={shape.id} />
          <AudioUploaderMinimal contextId={shape.id} label={`Upload to ${shape.id.slice(0, 6)}`} />
        </div>
      )}

      {/* Queue (scrollable) */}
      <div className="flex-1 overflow-y-auto px-3 pb-4 pt-3 scrollbar-thin scrollbar-thumb-rounded-md scrollbar-thumb-muted-foreground/10 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/20">
        <Queue contextId={shape.id} />
      </div>
    </div>
  );
};

/**
 * Inline editable shape name. Mutators see a click-to-edit pencil; non-mutators
 * see the static label. Enter / blur commits, Esc cancels, empty commits clear
 * the name (which falls back to the zoneDisplayName id-based default).
 */
function ShapeNameEditor({
  shape,
  canMutate,
  send,
}: {
  shape: { id: string; name?: string };
  canMutate: boolean;
  send: (req: Parameters<typeof sendWSRequest>[0]["request"]) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const fallback = zoneDisplayName({ id: shape.id });
  const displayed = zoneDisplayName(shape);

  const startEdit = () => {
    if (!canMutate) return;
    setDraft(shape.name ?? "");
    setIsEditing(true);
  };
  const commit = () => {
    setIsEditing(false);
    const next = draft.trim();
    if (next === (shape.name ?? "")) return;
    send({ type: ClientActionEnum.enum.SET_SHAPE_NAME, shapeId: shape.id, name: next });
  };
  const cancel = () => {
    setIsEditing(false);
    setDraft("");
  };

  if (isEditing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={80}
        placeholder={fallback}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className="w-full bg-transparent border border-neutral-700 rounded px-1.5 py-0.5 text-sm font-semibold text-neutral-100 outline-none focus:border-neutral-500"
      />
    );
  }

  return (
    <div
      onClick={startEdit}
      className={`truncate text-sm font-semibold text-neutral-100 ${canMutate ? "cursor-pointer hover:text-white" : ""}`}
      title={canMutate ? "Click to rename zone" : undefined}
    >
      {displayed}
    </div>
  );
}
