"use client";
// Playlist column for the map dashboard, next to the map in the center area.
// Two tabs:
//   - "Zone": the selected shape's playlist — the SAME Queue/Uploader
//     components audio rooms use, scoped to contextId == shape.id. Header with
//     shape title, loop toggle, deselect and delete-shape buttons.
//   - "Room pool": the room-wide main-context playlist (what room uploads and
//     the server-side bulk import fill) — upload to it, and add its tracks to
//     the selected zone (RoomPoolList).
//
// What does NOT live here:
//   - Map rendering — MapCanvas
//   - Ensemble play/pause — EnsembleControls in the bottom bar
//   - Chat / user list — those still live in Right / Left

import { Queue } from "@/components/Queue";
import { AddTracks } from "./AddTracks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { matchBeatgridsToTracks, parseBeatgridFile } from "@/lib/beatgridFile";
import { exportPlaylistToFile, parsePlaylistFile } from "@/lib/playlistFile";
import { extractFileNameFromUrl } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { useRoomStore } from "@/store/room";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum, MAIN_CONTEXT_ID, MAP_CONSTANTS, zoneDisplayName } from "@beatsync/shared";
import { Download, Music2, Repeat, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { RoomPoolList } from "./RoomPoolList";

interface MapShapePanelProps {
  canMutate: boolean;
}

// extractFileNameFromUrl throws on URLs with no path segment; a sync tooltip
// isn't worth crashing the panel over, so fall back to omitting the title.
function safeTrackTitle(url: string): string | undefined {
  try {
    return extractFileNameFromUrl(url);
  } catch {
    return undefined;
  }
}

export const MapShapePanel = ({ canMutate }: MapShapePanelProps) => {
  const shapes = useMapStore((s) => s.shapes);
  const selectedShapeId = useMapStore((s) => s.selectedShapeId);
  const playlist = useGlobalStore((s) => (selectedShapeId ? s.playlists.get(selectedShapeId) : undefined));
  const playlists = useGlobalStore((s) => s.playlists);
  const isConnected = useGlobalStore((s) => s.socket?.readyState === WebSocket.OPEN);
  const roomId = useRoomStore((s) => s.roomId);
  const pool = useGlobalStore((s) => s.playlists.get(MAIN_CONTEXT_ID));
  const importInputRef = useRef<HTMLInputElement>(null);
  const beatgridInputRef = useRef<HTMLInputElement>(null);
  const poolImportInputRef = useRef<HTMLInputElement>(null);
  const poolBeatgridInputRef = useRef<HTMLInputElement>(null);
  const [poolClearOpen, setPoolClearOpen] = useState(false);

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

  const send = (req: Parameters<typeof sendWSRequest>[0]["request"]) => {
    const socket = useGlobalStore.getState().socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    sendWSRequest({ ws: socket, request: req });
  };

  const handleExport = () => {
    if (!shape) return;
    if (!playlist || playlist.tracks.length === 0) {
      toast.error("This zone has no tracks to export.");
      return;
    }
    exportPlaylistToFile(playlist, { roomId, label: `zone-${shape.id.slice(0, 6)}` });
  };

  const handleImportFile = async (file: File) => {
    if (!shape) return;
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
      toast.error(err instanceof Error ? err.message : "Could not import beatgrids.");
    }
  };

  const handlePoolExport = () => {
    if (!pool || pool.tracks.length === 0) {
      toast.error("The Room Pool has no tracks to export.");
      return;
    }
    exportPlaylistToFile(pool, { roomId, label: "room-pool" });
  };

  const handlePoolImportFile = async (file: File) => {
    try {
      const doc = await parsePlaylistFile(file);
      const urls = doc.tracks.map((t) => t.url);
      if (urls.length === 0) {
        toast.error("That playlist file has no tracks.");
        return;
      }
      send({ type: ClientActionEnum.enum.IMPORT_TRACKS_TO_CONTEXT, contextId: MAIN_CONTEXT_ID, urls });
      toast.success(`Importing ${urls.length} track${urls.length === 1 ? "" : "s"} to the Room Pool…`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not import that file.");
    }
  };

  // Clear = delete every pool track. Because a pool track is one object
  // referenced from many zones, this removes them from the pool AND every zone
  // AND deletes the files — the whole room's audio. Confirmed via dialog.
  const confirmPoolClear = () => {
    const urls = (pool?.tracks ?? []).map((t) => t.url);
    if (urls.length > 0) {
      send({ type: ClientActionEnum.enum.DELETE_AUDIO_SOURCES, urls });
      toast.success(`Cleared ${urls.length} track${urls.length === 1 ? "" : "s"} from the room.`);
    }
    setPoolClearOpen(false);
  };

  return (
    <Tabs defaultValue="zone" className="flex h-full flex-col gap-0 overflow-hidden">
      <div className="border-b border-neutral-800/50 px-3 py-2">
        <TabsList className="h-8 w-full">
          <TabsTrigger value="zone" className="text-xs">
            Zone
          </TabsTrigger>
          <TabsTrigger value="pool" className="text-xs">
            Room Pool
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="zone" className="flex min-h-0 flex-col overflow-hidden data-[state=inactive]:hidden">
        {shape ? (
          <ZoneTab />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-neutral-500">
            <div>Select a zone on the map to edit its playlist.</div>
            {shapes.size === 0 && canMutate && (
              <div className="text-neutral-600">Draw one with the toolbar in the top-left of the map.</div>
            )}
          </div>
        )}
      </TabsContent>

      <TabsContent value="pool" className="flex min-h-0 flex-col overflow-hidden data-[state=inactive]:hidden">
        {canMutate && (
          <div className="flex items-center justify-between gap-2 border-b border-neutral-800/50 px-4 py-3">
            <div className="min-w-0 flex-1 text-xs font-medium text-neutral-300">Room Pool</div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-1.5 text-neutral-500 hover:text-neutral-200"
                title="Export the Room Pool"
                disabled={!pool || pool.tracks.length === 0}
                onClick={handlePoolExport}
              >
                <Download className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-1.5 text-neutral-500 hover:text-neutral-200"
                title="Import a playlist into the Room Pool"
                disabled={!isConnected}
                onClick={() => poolImportInputRef.current?.click()}
              >
                <Upload className="size-3.5" />
              </Button>
              <input
                ref={poolImportInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = ""; // allow re-importing the same file
                  if (file) void handlePoolImportFile(file);
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-1.5 text-neutral-500 hover:text-neutral-200"
                title="Import beatgrids (extract_beatgrids.py JSON) — matches every track in the room"
                disabled={!isConnected}
                onClick={() => poolBeatgridInputRef.current?.click()}
              >
                <Music2 className="size-3.5" />
              </Button>
              <input
                ref={poolBeatgridInputRef}
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
                title="Clear the Room Pool (deletes every track from the room)"
                disabled={!isConnected || !pool || pool.tracks.length === 0}
                onClick={() => setPoolClearOpen(true)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
        {canMutate && (
          <div className="px-3 pt-3">
            <AddTracks label="Upload to Room Pool" destination="Room Pool" />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3 scrollbar-thin scrollbar-thumb-rounded-md scrollbar-thumb-muted-foreground/10 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/20">
          <RoomPoolList canMutate={canMutate} />
        </div>

        <Dialog open={poolClearOpen} onOpenChange={setPoolClearOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Clear the Room Pool?</DialogTitle>
              <DialogDescription>
                Deletes all {pool?.tracks.length ?? 0} track{(pool?.tracks.length ?? 0) === 1 ? "" : "s"} from the room
                — removed from the pool <span className="font-medium text-neutral-200">and every zone</span>, and the
                files are deleted. This can’t be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setPoolClearOpen(false)}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={confirmPoolClear}>
                Clear the room
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TabsContent>
    </Tabs>
  );

  // The zone playlist view — only rendered with a shape selected. A nested
  // component (not early returns) so the Tabs skeleton always mounts and the
  // pool tab stays reachable with nothing selected.
  function ZoneTab() {
    if (!shape) return null;

    // Beat-sync state for the selected zone. A zone is a sync candidate (master)
    // when it's playing a gridded track and isn't the selected zone itself.
    const playingTrack = playlist?.playbackState.audioSource
      ? playlist.tracks.find((t) => t.url === playlist.playbackState.audioSource)
      : undefined;
    const playbackRate = playlist?.playbackState.playbackRate ?? 1;
    const isZonePlaying = playlist?.playbackState.type === "playing";
    const syncCandidates = Array.from(playlists.values())
      .filter((p) => p.id !== shape.id && shapes.has(p.id) && p.playbackState.type === "playing")
      .map((p) => {
        const playing = p.tracks.find((t) => t.url === p.playbackState.audioSource);
        return {
          contextId: p.id,
          label: zoneDisplayName(shapes.get(p.id) ?? { id: p.id }),
          beatgrid: playing?.beatgrid,
          trackTitle: playing ? safeTrackTitle(playing.url) : undefined,
        };
      });

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
          {/* Deselect is a view action, so it's available to everyone. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-1.5 text-neutral-500 hover:text-neutral-200"
            title="Deselect zone"
            onClick={() => useMapStore.getState().setSelectedShapeId(null)}
          >
            <X className="size-3.5" />
          </Button>
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
                        ? `Beat-match this zone to ${c.label} (${c.beatgrid.bpm} BPM)` +
                          (c.trackTitle ? ` — playing: ${c.trackTitle}` : "")
                        : `${c.label}'s playing track has no beatgrid`
                    }
                    onClick={() =>
                      send({
                        type: ClientActionEnum.enum.SYNC_ZONES,
                        masterContextId: c.contextId,
                        followerContextId: shape.id,
                      })
                    }
                  >
                    Sync to {c.label}
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
          <div className="px-3 pt-3">
            <AddTracks contextId={shape.id} label={`Upload to ${zoneDisplayName(shape)}`} />
          </div>
        )}

        {/* Queue (scrollable) */}
        <div className="flex-1 overflow-y-auto px-3 pb-4 pt-3 scrollbar-thin scrollbar-thumb-rounded-md scrollbar-thumb-muted-foreground/10 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/20">
          <Queue contextId={shape.id} />
        </div>
      </div>
    );
  }
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
