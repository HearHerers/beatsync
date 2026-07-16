"use client";
// A room-pool row: the shared PlaylistRow with pool semantics — clicking the
// row/play button auditions the track LOCALLY (usePreviewPlayer, unsynced), and
// the trailing actions are "add to the selected zone" and "delete from the
// room". No synced playback here; the pool is a library, not a live queue.

import { PlaylistRow } from "@/components/PlaylistRow";
import { Button } from "@/components/ui/button";
import { usePreviewPlayer } from "@/lib/previewPlayer";
import type { AudioSourceState } from "@/store/global";
import { Check, Plus, Trash2 } from "lucide-react";

export const PoolRow = ({
  sourceState,
  index,
  canMutate,
  isConnected,
  inZone,
  zoneLabel,
  hasShape,
  onAddToZone,
  onRequestDelete,
}: {
  sourceState: AudioSourceState;
  index: number;
  canMutate: boolean;
  isConnected: boolean;
  inZone: boolean;
  zoneLabel: string | null;
  hasShape: boolean;
  onAddToZone: (url: string) => void;
  onRequestDelete: (url: string) => void;
}) => {
  const url = sourceState.source.url;
  const previewing = usePreviewPlayer((s) => s.url === url);
  const toggle = usePreviewPlayer((s) => s.toggle);

  return (
    <PlaylistRow
      id={url}
      sourceState={sourceState}
      index={index}
      canMutate={canMutate}
      active={previewing}
      playing={previewing}
      showDuration={false}
      onActivate={() => canMutate && toggle(url)}
      actions={
        canMutate ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={`h-6 px-1 ${inZone ? "text-green-500" : "text-neutral-400 hover:text-white"}`}
              disabled={!isConnected || !hasShape || inZone}
              title={!hasShape ? "Select a zone first" : inZone ? `Already in ${zoneLabel}` : `Add to ${zoneLabel}`}
              onClick={(e) => {
                e.stopPropagation();
                onAddToZone(url);
              }}
            >
              {inZone ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
            </Button>
            <button
              className="p-1 rounded-full text-neutral-500 hover:text-red-400 transition-colors hover:scale-110 duration-150 focus:outline-none focus:text-red-400 focus:scale-110 disabled:opacity-40"
              disabled={!isConnected}
              title="Delete from the room (removes it from every zone)"
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete(url);
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        ) : undefined
      }
    />
  );
};
