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
// Also the home of local load status: the server's "N of M zones playing" can
// be true while THIS device is still downloading a zone's audio (the
// slow-connection silent gap) — an amber spinner with live % makes that state
// visible, and "Preload" downloads every zone's track up front so entering any
// zone starts instantly. Both are device-local (available to listeners too).
//
// No skip/shuffle — those are per-context concerns and live in the per-shape
// queue (clicking a track).

import { Button } from "@/components/ui/button";
import { useLocalZonePlayback } from "@/hooks/useLocalZonePlayback";
import { mapAudio } from "@/lib/mapAudio";
import { useCanMutate, useGlobalStore } from "@/store/global";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
import { HardDriveDownload, Loader2, Pause, Play } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

export const EnsembleControls = () => {
  const canMutate = useCanMutate();
  const playlists = useGlobalStore((s) => s.playlists);
  const isConnected = useGlobalStore((s) => s.socket?.readyState === WebSocket.OPEN);
  const broadcastPlayAll = useGlobalStore((s) => s.broadcastPlayAll);
  const broadcastPauseAll = useGlobalStore((s) => s.broadcastPauseAll);
  const localStates = useLocalZonePlayback();

  // Derive counts + the contextId list for each operation. Skip the main
  // context — in a map room it's the Room Pool (a superset library), not a
  // playable zone.
  const { playingCount, totalWithTracks, playContextIds, pauseContextIds, loadingCount, loadingPct } = useMemo(() => {
    let playing = 0;
    let withTracks = 0;
    let loading = 0;
    let loadedBytes = 0;
    let totalBytes = 0;
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
      // Any locally-loading zone counts (playing zones AND preloads) — either
      // way this device is mid-download and the zone is silent here.
      const local = localStates.get(p.id);
      if (local?.state === "loading") {
        loading++;
        if (local.totalBytes) {
          loadedBytes += local.loadedBytes ?? 0;
          totalBytes += local.totalBytes;
        }
      }
    }
    return {
      playingCount: playing,
      totalWithTracks: withTracks,
      playContextIds: playableIds,
      pauseContextIds: pausableIds,
      loadingCount: loading,
      // Aggregate download % across every in-flight zone; null while no
      // content-length is known yet (shows a plain spinner).
      loadingPct: totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : null,
    };
  }, [playlists, localStates]);

  const anyPlaying = playingCount > 0;
  const disabled = !isConnected || totalWithTracks === 0;

  const toggle = () => {
    if (anyPlaying) {
      broadcastPauseAll(pauseContextIds);
    } else {
      broadcastPlayAll(playContextIds);
    }
  };

  const handlePreload = () => {
    const { started, total } = mapAudio.preloadAllZones();
    if (total === 0) {
      toast.info("No zone audio to preload yet.");
    } else if (started === 0) {
      toast.success(`All ${total} zone${total === 1 ? "" : "s"} already loaded on this device.`);
    } else {
      toast.info(`Preloading ${started} zone${started === 1 ? "" : "s"}…`);
    }
  };

  return (
    // Right-align the entire row so the bottom-left corner stays free for the
    // Next.js dev overlay (which would otherwise cover the status text).
    <div className="flex w-full items-center justify-end gap-3">
      <div className="flex items-center gap-2 text-xs text-neutral-400">
        <span>
          {totalWithTracks === 0
            ? canMutate
              ? "Draw a zone and add audio to start"
              : "Nothing playing yet"
            : `${playingCount} of ${totalWithTracks} zone${totalWithTracks === 1 ? "" : "s"} playing`}
        </span>
        {loadingCount > 0 && (
          <span className="flex items-center gap-1 text-amber-400/90">
            <Loader2 className="size-3 animate-spin" />
            {loadingCount === 1 ? "loading audio" : `loading ${loadingCount} zones`}
            {loadingPct != null && ` ${loadingPct}%`}
          </span>
        )}
      </div>
      {/* Device-local: downloads every zone's current track now so entering
          any zone starts instantly. Not gated on canMutate — listeners on slow
          connections are exactly who needs it. */}
      {totalWithTracks > 0 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={handlePreload}
          disabled={loadingCount > 0}
          className="h-8 px-2 text-xs text-neutral-400 hover:text-neutral-100"
          title="Download all zone audio to this device now, so playback starts instantly when you enter a zone (uses data)"
        >
          <HardDriveDownload className="mr-1 size-3.5" /> Preload
        </Button>
      )}
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
