"use client";
// Bottom-bar transport for map rooms. Treats every shape's playlist as part of
// one synchronized installation:
//
//   - If anything is playing → "Pause all" pauses every currently-playing
//     context, capturing each zone's position at ONE shared instant.
//   - Otherwise → "Play all" starts every playlist that has at least one track
//     from position 0, locked to one shared serverTimeToExecute (phase-aligned).
//   - When paused zones hold captured positions, a "Resume all" button restarts
//     them from those positions at one shared instant — relative phase between
//     zones (including beat-sync lock) survives the pause/resume cycle.
//
// Server-side batched coordination guarantees every zone receives the same
// scheduled instant — so commensurate loops stay musically in phase.
//
// No skip/shuffle — those are per-context concerns and live in the per-shape
// queue (clicking a track).

import { Button } from "@/components/ui/button";
import { useCanMutate, useGlobalStore } from "@/store/global";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
import { Pause, Play, StepForward } from "lucide-react";
import { useMemo } from "react";

export const EnsembleControls = () => {
  const canMutate = useCanMutate();
  const playlists = useGlobalStore((s) => s.playlists);
  const isConnected = useGlobalStore((s) => s.socket?.readyState === WebSocket.OPEN);
  const broadcastPlayAll = useGlobalStore((s) => s.broadcastPlayAll);
  const broadcastPauseAll = useGlobalStore((s) => s.broadcastPauseAll);

  // Derive counts + the contextId list for each operation. Main is the back-
  // compat audio-room playlist and is empty in map rooms anyway.
  const { playingCount, totalWithTracks, playContextIds, pauseContextIds, resumableCount } = useMemo(() => {
    let playing = 0;
    let withTracks = 0;
    let resumable = 0;
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
      } else if (p.playbackState.audioSource && p.playbackState.trackPositionSeconds > 0) {
        // Paused mid-track (position captured by Pause All) — resumable.
        resumable++;
      }
    }
    return {
      playingCount: playing,
      totalWithTracks: withTracks,
      playContextIds: playableIds,
      pauseContextIds: pausableIds,
      resumableCount: resumable,
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
          ? canMutate
            ? "Draw a zone and add audio to start"
            : "Nothing playing yet"
          : `${playingCount} of ${totalWithTracks} zone${totalWithTracks === 1 ? "" : "s"} playing`}
      </div>
      {canMutate && !anyPlaying && resumableCount > 0 && (
        <Button
          size="sm"
          variant="default"
          onClick={() => broadcastPlayAll(playContextIds, { resume: true })}
          disabled={disabled}
          className="h-8 px-3 text-xs"
          title={`Resume ${resumableCount} paused zone${resumableCount === 1 ? "" : "s"} from where they stopped (relative phase preserved)`}
        >
          <StepForward className="mr-1 size-3.5" /> Resume all
        </Button>
      )}
      {canMutate && (
        <Button
          size="sm"
          variant={anyPlaying ? "secondary" : resumableCount > 0 ? "secondary" : "default"}
          onClick={toggle}
          disabled={disabled}
          className="h-8 px-3 text-xs"
          title={
            anyPlaying ? "Pause every playing zone (positions are kept for Resume)" : "Start every zone from the top"
          }
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
