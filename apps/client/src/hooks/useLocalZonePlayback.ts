"use client";
// Reactive view of mapAudio's per-shape LOCAL playback state ("playing" /
// "loading" / "idle"). mapAudio is imperative (plain Maps of Web Audio nodes),
// so we poll a cheap snapshot and only publish a new Map when something
// actually changed — consumers re-render on transitions, not on every tick.
//
// This is what lets the UI distinguish "the server says this zone is playing"
// from "this device is actually producing sound": while a track downloads or
// decodes the state reads "loading", and a range-culled or failed zone reads
// "idle" (#82 silent-playing analysis).

import { mapAudio, type ShapeLocalPlayback } from "@/lib/mapAudio";
import { useEffect, useState } from "react";

const POLL_MS = 500;

function statesEqual(a: Map<string, ShapeLocalPlayback>, b: Map<string, ShapeLocalPlayback>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, state] of a) {
    if (b.get(id) !== state) return false;
  }
  return true;
}

export function useLocalZonePlayback(): Map<string, ShapeLocalPlayback> {
  const [states, setStates] = useState<Map<string, ShapeLocalPlayback>>(new Map());

  useEffect(() => {
    const id = setInterval(() => {
      const next = mapAudio.getLocalPlaybackStates();
      setStates((prev) => (statesEqual(prev, next) ? prev : next));
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  return states;
}
