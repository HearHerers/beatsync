"use client";
// Now-playing + progress strip for the bottom bar (map rooms have no global
// Player, so this is where playback progress surfaces — #82). Rendered inline
// inside EnsembleControls next to the "N of M zones playing" status.
//
// Scope: shows the SELECTED zone's track only (map rooms can play several
// zones at once — the selected one is the natural focus). Nothing selected,
// or selected zone not playing → renders nothing.
//
// The zone's play state (current track + playing/paused) comes from the server-
// mirrored per-context playbackState in the global store. The live position +
// duration come from mapAudio.getDebugInfo(), which derives the current buffer
// position from the AudioContext clock. When the listener is range-culled (too
// far to hear the zone) the local source is torn down, so there's no live
// position — we still show the track name and a "move closer" hint.

import { mapAudio } from "@/lib/mapAudio";
import { extractFileNameFromUrl, formatTime } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { zoneDisplayName } from "@beatsync/shared";
import { Music } from "lucide-react";
import { useEffect, useState } from "react";

export function ZonePlaybackProgress() {
  const shapeId = useMapStore((s) => s.selectedShapeId);
  const shape = useMapStore((s) => (s.selectedShapeId ? s.shapes.get(s.selectedShapeId) : undefined));
  const playback = useGlobalStore((s) => (shapeId ? s.playlists.get(shapeId)?.playbackState : undefined));
  const isPlaying = playback?.type === "playing" && !!playback.audioSource;
  const audioSource = playback?.type === "playing" ? playback.audioSource : undefined;

  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [localPlaying, setLocalPlaying] = useState(false);

  useEffect(() => {
    if (!isPlaying || !shapeId) return;
    // Poll (not synchronous in the effect body) so we only setState from the
    // interval callback — avoids the cascading-render lint and is plenty smooth
    // for a progress bar.
    const id = setInterval(() => {
      const info = mapAudio.getDebugInfo().find((d) => d.shapeId === shapeId);
      if (info?.isPlaying && info.currentPosition != null && info.bufferDuration) {
        setPos(info.currentPosition);
        setDur(info.bufferDuration);
        setLocalPlaying(true);
      } else {
        setLocalPlaying(false);
      }
    }, 250);
    return () => clearInterval(id);
  }, [isPlaying, shapeId, audioSource]);

  if (!isPlaying || !audioSource) return null;

  const name = extractFileNameFromUrl(audioSource);
  const pct = localPlaying && dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px]">
      <Music className="size-3 shrink-0 text-green-500" />
      {shape && <span className="hidden shrink-0 text-neutral-500 sm:inline">{zoneDisplayName(shape)}</span>}
      <span className="truncate text-neutral-300">{name}</span>
      {localPlaying && dur > 0 ? (
        <>
          <div className="h-1 min-w-12 max-w-60 flex-1 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-green-500 transition-[width] duration-200 ease-linear"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-neutral-500">
            {formatTime(pos)} / {formatTime(dur)}
          </span>
        </>
      ) : (
        <span className="shrink-0 text-[10px] text-neutral-500">move closer to hear</span>
      )}
    </div>
  );
}
