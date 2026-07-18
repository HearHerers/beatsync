// Tests for beatgrid import matching: filename first, then title/artist
// metadata (covers Navidrome-streamed tracks stored as "Artist - Title"),
// with ambiguous keys discarded rather than guessed.

import { describe, expect, it } from "bun:test";
import { matchBeatgridsToTracks, type BeatgridExportType } from "@/lib/beatgridFile";

// Real extracted values (rekordbox-integration/beatgrids.json).
const HEAT3 = {
  file: "06 - Shinichi Atobe - Heat 3.flac",
  title: "Heat 3",
  artist: "Shinichi Atobe",
  bpm: 123.0,
  firstBeatSec: 0.052,
  firstDownbeatSec: 0.052,
  beatsPerBar: 4,
  grid: "constant" as const,
};
const BUMP = {
  file: "06 - Bump Talkin.flac",
  title: "Bump Talkin",
  artist: "Paul Johnson",
  bpm: 132.4,
  firstBeatSec: 0.004,
  firstDownbeatSec: 0.004,
  beatsPerBar: 4,
  grid: "constant" as const,
};

function doc(tracks: BeatgridExportType["tracks"]): BeatgridExportType {
  return { beatsyncBeatgrids: 1, tracks };
}

// R2-style URL: room prefix + display name + "___timestamp" delimiter + ext.
const r2Url = (displayName: string) =>
  `https://cdn.example.com/room-123456/${encodeURIComponent(`${displayName}___1770000000000.flac`)}`;

describe("matchBeatgridsToTracks", () => {
  it("matches uploads by filename (existing behavior)", () => {
    const r = matchBeatgridsToTracks(doc([HEAT3]), [r2Url("06 - Shinichi Atobe - Heat 3")]);
    expect(r.matches).toHaveLength(1);
    expect(r.matchedByMetadata).toBe(0);
    expect(r.matches[0].beatgrid.bpm).toBe(123.0);
  });

  it("falls back to 'Artist - Title' for Navidrome-style display names", () => {
    // Navidrome streams are stored under the search result's formatted name.
    const r = matchBeatgridsToTracks(doc([HEAT3, BUMP]), [
      r2Url("Shinichi Atobe - Heat 3"),
      r2Url("Paul Johnson - Bump Talkin"),
    ]);
    expect(r.matches).toHaveLength(2);
    expect(r.matchedByMetadata).toBe(2);
    expect(r.unmatchedFiles).toHaveLength(0);
  });

  it("falls back to bare title as a last resort", () => {
    const r = matchBeatgridsToTracks(doc([HEAT3]), [r2Url("Heat 3")]);
    expect(r.matches).toHaveLength(1);
    expect(r.matchedByMetadata).toBe(1);
  });

  it("prefers the filename match when both would hit", () => {
    const r = matchBeatgridsToTracks(doc([HEAT3]), [r2Url("06 - Shinichi Atobe - Heat 3"), r2Url("Heat 3")]);
    // Filename key wins for the entry; the title-only URL stays unmatched
    // (each entry matches through exactly one key).
    expect(r.matches).toHaveLength(1);
    expect(r.matchedByMetadata).toBe(0);
    expect(decodeURIComponent(r.matches[0].url)).toContain("06 - Shinichi Atobe - Heat 3");
  });

  it("stamps every room URL sharing the matched display name", () => {
    // Same track streamed twice → two URLs with the same display name.
    const urls = [r2Url("Shinichi Atobe - Heat 3"), r2Url("Shinichi Atobe - Heat 3").replace("123456", "999999")];
    const r = matchBeatgridsToTracks(doc([HEAT3]), urls);
    expect(r.matches).toHaveLength(2);
  });

  it("discards keys claimed by multiple entries instead of guessing", () => {
    // Two different grids share a bare title — title matching must not fire.
    const remix = { ...BUMP, file: "01 - Heat 3 (Remix).flac", title: "Heat 3", artist: "Someone Else" };
    const r = matchBeatgridsToTracks(doc([HEAT3, remix]), [r2Url("Heat 3")]);
    expect(r.matches).toHaveLength(0);
    expect(r.unmatchedFiles).toHaveLength(2);
    // But the unambiguous artist-title key still works for the same entries.
    const r2 = matchBeatgridsToTracks(doc([HEAT3, remix]), [r2Url("Shinichi Atobe - Heat 3")]);
    expect(r2.matches).toHaveLength(1);
    expect(r2.matches[0].beatgrid.bpm).toBe(123.0);
  });

  it("skips dynamic grids and entries without metadata gracefully", () => {
    const dynamic = { ...HEAT3, grid: "dynamic" as const };
    const noMeta = { ...BUMP, title: null, artist: null };
    const r = matchBeatgridsToTracks(doc([dynamic, noMeta]), [r2Url("Paul Johnson - Bump Talkin")]);
    expect(r.skippedDynamic).toEqual([HEAT3.file]);
    // noMeta only has its filename key, which doesn't match the streamed name.
    expect(r.matches).toHaveLength(0);
    expect(r.unmatchedFiles).toEqual([BUMP.file]);
  });
});
