// Tests for beatgrid matching primitives: filename first, then title/artist
// metadata (covers Navidrome-streamed tracks stored as "Artist - Title"),
// ambiguous keys discarded rather than guessed, and normalization that
// canonicalizes representation (sanitizer parity, NFC, dash/whitespace
// folding) without relaxing exactness. See BEATGRID_MATCHING_PLAN.md.

import { describe, expect, it } from "bun:test";
import {
  buildBeatgridKeyMap,
  looseNameTokens,
  looseTitleMatches,
  matchBeatgridsToTracks,
  normalizeName,
  resolveBeatgridCandidates,
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

describe("looseNameTokens / looseTitleMatches (duration-fallback tier)", () => {
  it("strips track numbers, parenthetical qualifiers, and feat clauses", () => {
    expect(looseNameTokens("06 - Shinichi Atobe - Heat 3.flac")).toEqual(["shinichi", "atobe", "heat", "3"]);
    expect(looseNameTokens("Heat 3 (2019 Remaster) [Deluxe]")).toEqual(["heat", "3"]);
    expect(looseNameTokens("Song feat. Somebody Else")).toEqual(["song"]);
    expect(looseNameTokens("Song (Extended Mix)")).toEqual(["song"]);
  });

  it("agrees on containment, not equality", () => {
    const roomTokens = new Set(looseNameTokens("01 - Shinichi Atobe - Heat 3 (Remastered)"));
    expect(looseTitleMatches(HEAT3, roomTokens)).toBe(true);
    expect(looseTitleMatches(BUMP, roomTokens)).toBe(false); // different title
  });

  it("falls back to the filename when the entry has no title, and never matches on empty", () => {
    const untitled = { ...HEAT3, title: null };
    expect(looseTitleMatches(untitled, new Set(looseNameTokens("Shinichi Atobe - Heat 3")))).toBe(true);
    const blank = { ...HEAT3, title: null, file: "().flac" };
    expect(looseTitleMatches(blank, new Set(["anything"]))).toBe(false);
  });
});

describe("buildBeatgridKeyMap (server index shape)", () => {
  it("indexes every key of constant-grid entries", () => {
    const { byKey, tracks, skippedDynamic, ambiguousKeys } = buildBeatgridKeyMap(doc([HEAT3, BUMP]));
    expect(tracks).toBe(2);
    expect(skippedDynamic).toBe(0);
    expect(ambiguousKeys).toBe(0);
    // filename, artist-title, and title keys for each entry.
    expect(byKey.get(normalizeName(HEAT3.file))?.[0].bpm).toBe(123.0);
    expect(byKey.get(normalizeName("Shinichi Atobe - Heat 3"))?.[0].bpm).toBe(123.0);
    expect(byKey.get(normalizeName("Bump Talkin"))?.[0].bpm).toBe(132.4);
  });

  it("keeps multi-owner keys as candidate lists for lookup-time resolution", () => {
    const remix = { ...BUMP, file: "01 - Heat 3 (Remix).flac", title: "Heat 3", artist: "Someone Else" };
    const { byKey, ambiguousKeys } = buildBeatgridKeyMap(doc([HEAT3, remix]));
    expect(ambiguousKeys).toBe(1); // the shared bare title
    expect(byKey.get(normalizeName("Heat 3"))).toHaveLength(2);
    expect(byKey.get(normalizeName("Shinichi Atobe - Heat 3"))?.[0].bpm).toBe(123.0);
    expect(byKey.get(normalizeName("Someone Else - Heat 3"))?.[0].bpm).toBe(132.4);
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
    expect(byKey.get(key)?.[0].durationSec).toBe(577);
  });
});

describe("resolveBeatgridCandidates", () => {
  const RIP_A = { ...BUMP, file: "06 - Bump Talkin.flac", durationSec: 309 };
  const RIP_B = {
    ...BUMP,
    file: "C1 - Bump Talkin.flac",
    bpm: 132.39,
    durationSec: 308,
    firstBeatSec: 0.115,
    firstDownbeatSec: 0.115,
  };

  it("treats equivalent grids as one entry (same audio ripped twice)", () => {
    const dupe = { ...HEAT3, file: "copy of Heat 3.flac", bpm: 123.01, durationSec: 578 };
    expect(resolveBeatgridCandidates([HEAT3, dupe])).toBe(HEAT3);
    expect(resolveBeatgridCandidates([HEAT3, dupe], 577)).toBe(HEAT3);
  });

  it("resolves different versions by duration with a clear margin", () => {
    // Two rips, downbeats 111ms apart — NOT interchangeable. Real duration
    // 309 is 1s closer to RIP_A than RIP_B: clear winner.
    expect(resolveBeatgridCandidates([RIP_A, RIP_B])).toBeUndefined(); // no duration → refuse
    expect(resolveBeatgridCandidates([RIP_A, RIP_B], 309)).toBe(RIP_A);
    expect(resolveBeatgridCandidates([RIP_A, RIP_B], 308.2)).toBe(RIP_B);
    expect(resolveBeatgridCandidates([RIP_A, RIP_B], 308.5)).toBeUndefined(); // dead tie → refuse
  });

  it("refuses when any candidate has no export duration to rank", () => {
    const unranked = { ...RIP_B, durationSec: undefined };
    expect(resolveBeatgridCandidates([RIP_A, unranked], 309)).toBeUndefined();
  });
});
