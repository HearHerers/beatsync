"use client";
// Reactive view of mapAudio's per-shape LOCAL state ("playing" / "loading" /
// "idle" + download progress). mapAudio is imperative (plain Maps of Web Audio
// nodes), so we poll a cheap snapshot and only publish a new Map when something
// actually changed — consumers re-render on transitions and on progress ticks
// while a download is in flight, not on every poll.
//
// This is what lets the UI distinguish "the server says this zone is playing"
// from "this device is actually producing sound": while a track downloads or
// decodes the state reads "loading" (with byte progress on slow connections),
// and a range-culled or failed zone reads "idle".

import { mapAudio, type ZoneLoadInfo } from "@/lib/mapAudio";
import { useEffect, useState } from "react";

const POLL_MS = 500;

function statesEqual(a: Map<string, ZoneLoadInfo>, b: Map<string, ZoneLoadInfo>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, info] of a) {
    const other = b.get(id);
    if (!other) return false;
    if (other.state !== info.state || other.loadedBytes !== info.loadedBytes || other.totalBytes !== info.totalBytes) {
      return false;
    }
  }
  return true;
}

export function useLocalZonePlayback(): Map<string, ZoneLoadInfo> {
  const [states, setStates] = useState<Map<string, ZoneLoadInfo>>(new Map());

  useEffect(() => {
    const id = setInterval(() => {
      const next = mapAudio.getLocalStates();
      setStates((prev) => (statesEqual(prev, next) ? prev : next));
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  return states;
}
