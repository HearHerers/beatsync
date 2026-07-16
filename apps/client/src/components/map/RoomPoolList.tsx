"use client";
// Room-pool track list for map rooms. The main-context playlist IS the room's
// shared pool (it's what room-wide uploads and the server-side bulk import
// fill), so this reads playlists.get(MAIN_CONTEXT_ID) straight from the store.
//
// Rows use the shared PlaylistRow (same look + drag-reorder as zone playlists),
// but with pool semantics via PoolRow: play = local preview (unsynced), plus
// "add to the selected zone" and "delete from the room". Deletion removes the
// file everywhere (pool + every zone + the stored object), so it's gated behind
// a confirmation dialog.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { extractFileNameFromUrl } from "@/lib/utils";
import { usePreviewPlayer } from "@/lib/previewPlayer";
import { AudioSourceState, useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum, MAIN_CONTEXT_ID, zoneDisplayName } from "@beatsync/shared";
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis, restrictToWindowEdges } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ListPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PoolRow } from "./PoolRow";

interface RoomPoolListProps {
  canMutate: boolean;
}

export const RoomPoolList = ({ canMutate }: RoomPoolListProps) => {
  const pool = useGlobalStore((s) => s.playlists.get(MAIN_CONTEXT_ID));
  const audioSources = useGlobalStore((s) => s.audioSources);
  const isConnected = useGlobalStore((s) => s.socket?.readyState === WebSocket.OPEN);
  const broadcastReorder = useGlobalStore((s) => s.broadcastReorder);
  const playlists = useGlobalStore((s) => s.playlists);
  const shapes = useMapStore((s) => s.shapes);
  const selectedShapeId = useMapStore((s) => s.selectedShapeId);
  const zonePlaylist = useGlobalStore((s) => (selectedShapeId ? s.playlists.get(selectedShapeId) : undefined));
  // URL pending delete confirmation; drives the confirmation dialog (null = closed).
  const [deleteUrl, setDeleteUrl] = useState<string | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [deleteUnassignedOpen, setDeleteUnassignedOpen] = useState(false);

  // Stop any local preview when the pool list goes away (leaving the room).
  useEffect(() => () => usePreviewPlayer.getState().stop(), []);

  const shape = selectedShapeId ? shapes.get(selectedShapeId) : undefined;
  const zoneLabel = shape ? zoneDisplayName(shape) : null;
  const zoneUrls = new Set((zonePlaylist?.tracks ?? []).map((t) => t.url));
  const tracks = pool?.tracks ?? [];

  // How many zones (shape contexts, not the pool itself) each track is in —
  // powers the count badge so it's obvious which pool tracks are assigned to
  // zones vs. orphaned (0 → safe to delete).
  const zoneCountByUrl = new Map<string, number>();
  playlists.forEach((pl, id) => {
    if (id === MAIN_CONTEXT_ID) return;
    for (const t of pl.tracks) zoneCountByUrl.set(t.url, (zoneCountByUrl.get(t.url) ?? 0) + 1);
  });

  // Project pool tracks into AudioSourceState (loading/error state, when known,
  // comes from the global registry) so they render through the shared row.
  const byUrl = new Map(audioSources.map((as) => [as.source.url, as]));
  const items: AudioSourceState[] = tracks.map((t) => byUrl.get(t.url) ?? { source: t, status: "idle" });

  const send = (req: Parameters<typeof sendWSRequest>[0]["request"]) => {
    const socket = useGlobalStore.getState().socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    sendWSRequest({ ws: socket, request: req });
  };

  const handleAdd = (url: string) => {
    if (!shape) return;
    send({ type: ClientActionEnum.enum.ADD_TRACK_TO_CONTEXT, contextId: shape.id, source: { url } });
    toast.success(`Added to ${zoneLabel}`);
  };

  const doDelete = (url: string) => {
    send({ type: ClientActionEnum.enum.DELETE_AUDIO_SOURCES, urls: [url] });
    toast.success("Deleted from the room (removed from every zone).");
  };

  // Trash click: honor the persisted "don't ask again" choice, else confirm.
  const requestDelete = (url: string) => {
    if (skipPoolDeleteConfirm()) doDelete(url);
    else setDeleteUrl(url);
  };

  const confirmDelete = () => {
    if (!deleteUrl) return;
    if (dontAskAgain) setSkipPoolDeleteConfirm(true);
    doDelete(deleteUrl);
    setDeleteUrl(null);
  };

  // Only tracks in no zone at all — the ones that still need assigning.
  const unassigned = tracks.filter((t) => (zoneCountByUrl.get(t.url) ?? 0) === 0);
  const handleAddUnassigned = () => {
    if (!shape || unassigned.length === 0) return;
    send({
      type: ClientActionEnum.enum.IMPORT_TRACKS_TO_CONTEXT,
      contextId: shape.id,
      urls: unassigned.map((t) => t.url),
    });
    toast.success(`Adding ${unassigned.length} unassigned track${unassigned.length === 1 ? "" : "s"} to ${zoneLabel}…`);
  };

  const confirmDeleteUnassigned = () => {
    const urls = unassigned.map((t) => t.url);
    if (urls.length > 0) {
      send({ type: ClientActionEnum.enum.DELETE_AUDIO_SOURCES, urls });
      toast.success(`Deleted ${urls.length} unassigned track${urls.length === 1 ? "" : "s"} from the room.`);
    }
    setDeleteUnassignedOpen(false);
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (!canMutate) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((it) => it.source.url === active.id);
    const newIndex = items.findIndex((it) => it.source.url === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const orderedUrls = arrayMove(items, oldIndex, newIndex).map((it) => it.source.url);
    broadcastReorder(MAIN_CONTEXT_ID, orderedUrls);
  };

  if (tracks.length === 0) {
    return (
      <div className="px-1 py-6 text-center text-xs text-neutral-500">
        No tracks in the Room Pool yet.
        {canMutate && <div className="mt-1 text-neutral-600">Upload above to make songs available to every zone.</div>}
      </div>
    );
  }

  const rows = items.map((sourceState, index) => (
    <PoolRow
      key={sourceState.source.url}
      sourceState={sourceState}
      index={index}
      canMutate={canMutate}
      isConnected={isConnected}
      inZone={zoneUrls.has(sourceState.source.url)}
      zoneCount={zoneCountByUrl.get(sourceState.source.url) ?? 0}
      zoneLabel={zoneLabel}
      hasShape={Boolean(shape)}
      onAddToZone={handleAdd}
      onRequestDelete={requestDelete}
    />
  ));

  return (
    <div className="flex flex-col gap-0.5">
      {!shape && canMutate && (
        <div className="px-1 pb-2 text-[11px] text-neutral-500">
          Select a zone on the map to add pool tracks to its playlist.
        </div>
      )}

      {canMutate ? (
        <DndContext
          sensors={sensors}
          onDragEnd={handleDragEnd}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToWindowEdges]}
        >
          <SortableContext items={items.map((it) => it.source.url)} strategy={verticalListSortingStrategy}>
            {rows}
          </SortableContext>
        </DndContext>
      ) : (
        rows
      )}

      {canMutate && (
        <div className="mt-2 flex flex-col gap-1">
          {shape && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 justify-center gap-1.5 text-xs text-neutral-400 hover:text-white"
              disabled={!isConnected || unassigned.length === 0}
              title={unassigned.length === 0 ? "No unassigned tracks in the pool" : undefined}
              onClick={handleAddUnassigned}
            >
              <ListPlus className="size-3.5" />
              Add unassigned to {zoneLabel}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 justify-center gap-1.5 text-xs text-neutral-500 hover:text-red-400"
            disabled={!isConnected || unassigned.length === 0}
            title={unassigned.length === 0 ? "No unassigned tracks in the pool" : undefined}
            onClick={() => setDeleteUnassignedOpen(true)}
          >
            <Trash2 className="size-3.5" />
            Delete unassigned
          </Button>
        </div>
      )}

      <Dialog
        open={deleteUrl !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteUrl(null);
            setDontAskAgain(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="truncate">Delete “{deleteUrl ? safeTrackName(deleteUrl) : ""}”?</DialogTitle>
            <DialogDescription>
              Removes it from the Room Pool <span className="font-medium text-neutral-200">and every zone</span>, and
              deletes the file. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400 select-none">
            <input
              type="checkbox"
              className="size-3.5 accent-red-500"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            Don’t ask again on this device
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleteUrl(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete}>
              Delete everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteUnassignedOpen} onOpenChange={setDeleteUnassignedOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete unassigned tracks?</DialogTitle>
            <DialogDescription>
              Deletes the {unassigned.length} track{unassigned.length === 1 ? "" : "s"} that{" "}
              {unassigned.length === 1 ? "isn’t" : "aren’t"} in any zone — removed from the Room Pool and the file
              {unassigned.length === 1 ? "" : "s"} deleted. Tracks in a zone are untouched. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleteUnassignedOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDeleteUnassigned}>
              Delete unassigned
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/** Display name for a pool URL; never throws on odd URLs (external registrations). */
function safeTrackName(url: string): string {
  try {
    return extractFileNameFromUrl(url);
  } catch {
    return url;
  }
}

// Per-browser "skip the pool-delete confirmation" preference.
const SKIP_POOL_DELETE_KEY = "beatsync.hidePoolDeleteConfirm";
function skipPoolDeleteConfirm(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SKIP_POOL_DELETE_KEY) === "1";
  } catch {
    return false;
  }
}
function setSkipPoolDeleteConfirm(skip: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (skip) window.localStorage.setItem(SKIP_POOL_DELETE_KEY, "1");
    else window.localStorage.removeItem(SKIP_POOL_DELETE_KEY);
  } catch {
    /* ignore storage failures (private mode, quota) */
  }
}
