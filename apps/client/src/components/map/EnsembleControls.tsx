"use client";
// Bottom-bar transport for map rooms. Treats every shape's playlist as part of
// one synchronized installation, with a single toggle:
//
//   - If anything is playing → button shows "Pause all" and pauses every
//     currently-playing context.
//   - Otherwise → button shows "Play all" and starts every playlist that has
//     at least one track from position 0, locked to one shared
//     serverTimeToExecute on the server (phase-aligned).
//
// Server-side batched coordination guarantees every zone receives the same
// scheduled instant — so commensurate loops stay musically in phase.
//
// No skip/shuffle — those are per-context concerns and live in the per-shape
// queue (clicking a track).

import { Button } from "@/components/ui/button";
import { useCanMutate, useGlobalStore } from "@/store/global";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
import { Pause, Play } from "lucide-react";
import { useMemo } from "react";

export const EnsembleControls = () => {
  const canMutate = useCanMutate();
  const playlists = useGlobalStore((s) => s.playlists);
  const isConnected = useGlobalStore((s) => s.socket?.readyState === WebSocket.OPEN);
  const broadcastPlayAll = useGlobalStore((s) => s.broadcastPlayAll);
  const broadcastPauseAll = useGlobalStore((s) => s.broadcastPauseAll);

  // Derive counts + the contextId list for each operation. Skip the main
  // context — in a map room it's the Room Pool (a superset library), not a
  // playable zone.
  const { playingCount, totalWithTracks, playContextIds, pauseContextIds } = useMemo(() => {
    let playing = 0;
    let withTracks = 0;
    const playableIds: string[] = [];
    const pausableIds: string[] = [];
    for (const p of playlists.values()) {
      if (p.id === MAIN_CONTEXT_ID) continue;
      if (p.tracks.length > 0) {
        withTracks++;
        playableIds.push(p.id);
      }
      if (p.playbackState.type === "playing") {
        playing++;
        pausableIds.push(p.id);
      }
    }
    return {
      playingCount: playing,
      totalWithTracks: withTracks,
      playContextIds: playableIds,
      pauseContextIds: pausableIds,
    };
  }, [playlists]);

  const anyPlaying = playingCount > 0;
  const disabled = !isConnected || totalWithTracks === 0;

  const toggle = () => {
    if (anyPlaying) {
      broadcastPauseAll(pauseContextIds);
    } else {
      broadcastPlayAll(playContextIds);
    }
  };

  return (
    // Right-align the entire row so the bottom-left corner stays free for the
    // Next.js dev overlay (which would otherwise cover the status text).
    <div className="flex w-full items-center justify-end gap-3">
      <div className="text-xs text-neutral-400">
        {totalWithTracks === 0
          ? "Draw a zone and add audio to start"
          : `${playingCount} of ${totalWithTracks} zone${totalWithTracks === 1 ? "" : "s"} playing`}
      </div>
      {canMutate && (
        <Button
          size="sm"
          variant={anyPlaying ? "secondary" : "default"}
          onClick={toggle}
          disabled={disabled}
          className="h-8 px-3 text-xs"
        >
          {anyPlaying ? (
            <>
              <Pause className="mr-1 size-3.5" /> Pause all
            </>
          ) : (
            <>
              <Play className="mr-1 size-3.5" /> Play all
            </>
          )}
        </Button>
      )}
    </div>
  );
};
