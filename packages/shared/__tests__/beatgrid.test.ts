// Tests for beatgrid matching primitives: filename first, then title/artist
// metadata (covers Navidrome-streamed tracks stored as "Artist - Title"),
// ambiguous keys discarded rather than guessed, and normalization that
// canonicalizes representation (sanitizer parity, NFC, dash/whitespace
// folding) without relaxing exactness. See BEATGRID_MATCHING_PLAN.md.

import { describe, expect, it } from "bun:test";
import {
  buildBeatgridKeyMap,
  matchBeatgridsToTracks,
  normalizeName,
  sanitizeDisplayName,
  type BeatgridExportType,
} from "../beatgrid";

// Real extracted values (rekordbox-integration/beatgrids.json).
const HEAT3 = {
  file: "06 - Shinichi Atobe - Heat 3.flac",
  title: "Heat 3",
  artist: "Shinichi Atobe",
  bpm: 123.0,
  durationSec: 577,
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

describe("normalizeName hardening (BEATGRID_MATCHING_PLAN.md)", () => {
  it("sanitizer parity: export filenames with R2-sanitized characters still match", () => {
    // "Twelve:34.flac" uploads as display name "Twelve*34" (sanitize replaces
    // the colon). The export side keys on the raw filename — parity in
    // normalizeName makes both sides "twelve*34".
    const entry = { ...HEAT3, file: "Twelve:34.flac", title: null, artist: null };
    const r = matchBeatgridsToTracks(doc([entry]), [r2Url(sanitizeDisplayName("Twelve:34"))]);
    expect(r.matches).toHaveLength(1);
  });

  it("Unicode NFC: NFD-encoded room names (Mac uploads) match NFC export names", () => {
    const nfdName = "Café del Mar".normalize("NFD");
    const nfcFile = "Café del Mar.flac".normalize("NFC");
    expect(nfdName).not.toBe(nfcFile.replace(/\.[^/.]+$/, "")); // really different bytes
    const entry = { ...HEAT3, file: nfcFile, title: null, artist: null };
    const r = matchBeatgridsToTracks(doc([entry]), [r2Url(nfdName)]);
    expect(r.matches).toHaveLength(1);
  });

  it("folds dash variants and collapses whitespace in metadata keys", () => {
    // Provider display name joined with an en dash and doubled spaces.
    const r = matchBeatgridsToTracks(doc([HEAT3]), [r2Url("Shinichi Atobe  –  Heat 3")]);
    expect(r.matches).toHaveLength(1);
    expect(r.matchedByMetadata).toBe(1);
  });

  it("stays exact: a different title does not fuzzy-match", () => {
    const r = matchBeatgridsToTracks(doc([HEAT3]), [r2Url("Heat 33")]);
    expect(r.matches).toHaveLength(0);
  });
});

describe("buildBeatgridKeyMap (server index shape)", () => {
  it("indexes every unambiguous key of constant-grid entries", () => {
    const { byKey, tracks, skippedDynamic, ambiguousKeys } = buildBeatgridKeyMap(doc([HEAT3, BUMP]));
    expect(tracks).toBe(2);
    expect(skippedDynamic).toBe(0);
    expect(ambiguousKeys).toBe(0);
    // filename, artist-title, and title keys for each entry.
    expect(byKey.get(normalizeName(HEAT3.file))?.bpm).toBe(123.0);
    expect(byKey.get(normalizeName("Shinichi Atobe - Heat 3"))?.bpm).toBe(123.0);
    expect(byKey.get(normalizeName("Bump Talkin"))?.bpm).toBe(132.4);
  });

  it("discards ambiguous keys but keeps each entry's unique keys", () => {
    const remix = { ...BUMP, file: "01 - Heat 3 (Remix).flac", title: "Heat 3", artist: "Someone Else" };
    const { byKey, ambiguousKeys } = buildBeatgridKeyMap(doc([HEAT3, remix]));
    expect(ambiguousKeys).toBe(1); // the shared bare title
    expect(byKey.has(normalizeName("Heat 3"))).toBe(false);
    expect(byKey.get(normalizeName("Shinichi Atobe - Heat 3"))?.bpm).toBe(123.0);
    expect(byKey.get(normalizeName("Someone Else - Heat 3"))?.bpm).toBe(132.4);
  });

  it("skips dynamic entries entirely", () => {
    const dynamic = { ...HEAT3, grid: "dynamic" as const };
    const { byKey, tracks, skippedDynamic } = buildBeatgridKeyMap(doc([dynamic]));
    expect(tracks).toBe(0);
    expect(skippedDynamic).toBe(1);
    expect(byKey.size).toBe(0);
  });

  it("resolves the same key repeatedly (no per-lookup claiming)", () => {
    const { byKey } = buildBeatgridKeyMap(doc([HEAT3]));
    const key = normalizeName(HEAT3.file);
    expect(byKey.get(key)).toBe(byKey.get(key));
    expect(byKey.get(key)?.durationSec).toBe(577);
  });
});
