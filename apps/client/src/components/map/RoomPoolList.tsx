"use client";
// Room-pool track list for map rooms. The main-context playlist IS the room's
// shared pool (it's what room-wide uploads and the server-side bulk import
// fill), so this reads playlists.get(MAIN_CONTEXT_ID) straight from the store.
//
// Deliberately NOT the interactive Queue: clicking a main-context Queue row
// schedules room-wide playback, which is not what browsing the pool means.
// Rows here only offer "add to the selected zone" and (admins) "delete from
// the room" — deletion removes the file everywhere, so it's a two-click
// confirm.

import { Button } from "@/components/ui/button";
import { extractFileNameFromUrl } from "@/lib/utils";
import { zoneDisplayName } from "@/lib/zoneName";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum, MAIN_CONTEXT_ID } from "@beatsync/shared";
import { Check, ListPlus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface RoomPoolListProps {
  canMutate: boolean;
}

export const RoomPoolList = ({ canMutate }: RoomPoolListProps) => {
  const pool = useGlobalStore((s) => s.playlists.get(MAIN_CONTEXT_ID));
  const isConnected = useGlobalStore((s) => s.socket?.readyState === WebSocket.OPEN);
  const shapes = useMapStore((s) => s.shapes);
  const selectedShapeId = useMapStore((s) => s.selectedShapeId);
  const zonePlaylist = useGlobalStore((s) => (selectedShapeId ? s.playlists.get(selectedShapeId) : undefined));
  // URL awaiting delete confirmation; a second click on the same trash icon
  // performs the delete, clicking anything else resets it.
  const [pendingDeleteUrl, setPendingDeleteUrl] = useState<string | null>(null);

  const shape = selectedShapeId ? shapes.get(selectedShapeId) : undefined;
  const zoneLabel = shape ? zoneDisplayName(shape) : null;
  const zoneUrls = new Set((zonePlaylist?.tracks ?? []).map((t) => t.url));
  const tracks = pool?.tracks ?? [];

  const send = (req: Parameters<typeof sendWSRequest>[0]["request"]) => {
    const socket = useGlobalStore.getState().socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    sendWSRequest({ ws: socket, request: req });
  };

  if (tracks.length === 0) {
    return (
      <div className="px-1 py-6 text-center text-xs text-neutral-500">
        No tracks in the room pool yet.
        {canMutate && <div className="mt-1 text-neutral-600">Upload above to make songs available to every zone.</div>}
      </div>
    );
  }

  const handleAdd = (url: string) => {
    if (!shape) return;
    send({ type: ClientActionEnum.enum.ADD_TRACK_TO_CONTEXT, contextId: shape.id, source: { url } });
    toast.success(`Added to ${zoneLabel}`);
    setPendingDeleteUrl(null);
  };

  const handleDelete = (url: string) => {
    if (pendingDeleteUrl !== url) {
      setPendingDeleteUrl(url);
      return;
    }
    send({ type: ClientActionEnum.enum.DELETE_AUDIO_SOURCES, urls: [url] });
    toast.success("Deleted from the room (removed from every zone).");
    setPendingDeleteUrl(null);
  };

  const notYetInZone = tracks.filter((t) => !zoneUrls.has(t.url));
  const handleAddAll = () => {
    if (!shape || notYetInZone.length === 0) return;
    send({
      type: ClientActionEnum.enum.IMPORT_TRACKS_TO_CONTEXT,
      contextId: shape.id,
      urls: notYetInZone.map((t) => t.url),
    });
    toast.success(`Adding ${notYetInZone.length} track${notYetInZone.length === 1 ? "" : "s"} to ${zoneLabel}…`);
    setPendingDeleteUrl(null);
  };

  return (
    <div className="flex flex-col gap-0.5">
      {!shape && (
        <div className="px-1 pb-2 text-[11px] text-neutral-500">
          Select a zone on the map to add pool tracks to its playlist.
        </div>
      )}
      {tracks.map((track) => {
        const name = safeTrackName(track.url);
        const inZone = zoneUrls.has(track.url);
        const confirming = pendingDeleteUrl === track.url;
        return (
          <div
            key={track.url}
            className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-neutral-800/50"
          >
            <div className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={name}>
              {name}
            </div>
            {canMutate && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={`h-6 px-1 ${inZone ? "text-green-500" : "text-neutral-400 hover:text-white"}`}
                  disabled={!isConnected || !shape || inZone}
                  title={!shape ? "Select a zone first" : inZone ? `Already in ${zoneLabel}` : `Add to ${zoneLabel}`}
                  onClick={() => handleAdd(track.url)}
                >
                  {inZone ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={`h-6 px-1 ${
                    confirming
                      ? "text-red-400"
                      : "text-neutral-500 opacity-0 group-hover:opacity-100 hover:text-red-400"
                  }`}
                  disabled={!isConnected}
                  title={
                    confirming
                      ? "Click again to delete from the room AND every zone"
                      : "Delete from the room (removes it from every zone)"
                  }
                  onClick={() => handleDelete(track.url)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
          </div>
        );
      })}
      {canMutate && shape && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-2 h-7 justify-center gap-1.5 text-xs text-neutral-400 hover:text-white"
          disabled={!isConnected || notYetInZone.length === 0}
          title={notYetInZone.length === 0 ? `Every pool track is already in ${zoneLabel}` : undefined}
          onClick={handleAddAll}
        >
          <ListPlus className="size-3.5" />
          Add all to {zoneLabel}
        </Button>
      )}
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
