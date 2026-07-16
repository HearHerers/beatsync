"use client";
// Now-playing + progress bar for a single zone (map rooms have no global Player,
// so this is where playback progress surfaces — #82).
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
import { Music } from "lucide-react";
import { useEffect, useState } from "react";

export function ZonePlaybackProgress({ shapeId }: { shapeId: string }) {
  const playback = useGlobalStore((s) => s.playlists.get(shapeId)?.playbackState);
  const isPlaying = playback?.type === "playing" && !!playback.audioSource;
  const audioSource = playback?.audioSource;

  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [localPlaying, setLocalPlaying] = useState(false);

  useEffect(() => {
    if (!isPlaying) return;
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
    <div className="border-b border-neutral-800/50 px-4 py-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 text-neutral-300">
          <Music className="size-3 shrink-0 text-green-500" />
          <span className="truncate">{name}</span>
        </span>
        {localPlaying && dur > 0 && (
          <span className="shrink-0 font-mono text-neutral-500">
            {formatTime(pos)} / {formatTime(dur)}
          </span>
        )}
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full rounded-full bg-green-500 transition-[width] duration-200 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      {!localPlaying && (
        <div className="mt-1 text-[10px] text-neutral-500">Playing — move closer to hear this zone.</div>
      )}
    </div>
  );
}
