// Beatgrid export matching: shared primitives for joining entries exported by
// rekordbox-integration/extract_beatgrids.py to room track URLs (whose R2 keys
// embed the sanitized display name — see generateAudioFileName in the server's
// lib/r2.ts, which delegates its name-half to sanitizeDisplayName below so the
// two sides can never drift).
//
// Two consumers build on these primitives (see BEATGRID_AUTOLOAD_PLAN.md):
//   - matchBeatgridsToTracks: the client's manual-import batch matcher
//     (doc + room URLs, each URL claimed at most once per import),
//   - buildBeatgridKeyMap: the server BeatgridIndex's inverted key→entry map
//     for per-track lookup at queue time.
//
// Matching is exact-but-unique or nothing — no fuzzy matching. A wrong grid
// actively sounds worse than no grid, so keys claimed by more than one export
// entry are discarded as ambiguous, and normalization only canonicalizes
// representation (sanitizer parity, Unicode NFC, dash/whitespace folding); it
// never relaxes exactness. See BEATGRID_MATCHING_PLAN.md.

import sanitize from "sanitize-filename";
import { z } from "zod";
import { R2_AUDIO_FILE_NAME_DELIMITER } from "./constants";
import { BeatgridSchema, type BeatgridType } from "./types/basic";

// ── Export document schema ──────────────────────────────────────────

/** Format emitted by rekordbox-integration/extract_beatgrids.py. */
export const BeatgridExportTrackSchema = z.object({
  file: z.string(),
  /** Track metadata from the DJ library — used as a matching fallback. */
  title: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  bpm: z.number().positive(),
  /**
   * Track length from the DJ library DB (seconds). Sanity check against the
   * decoded audio's real duration to catch wrong-version matches (radio edit
   * vs. extended mix sharing a filename/title). Absent in older exports.
   */
  durationSec: z.number().positive().optional(),
  firstBeatSec: z.number().min(0),
  firstDownbeatSec: z.number().min(0),
  beatsPerBar: z.number().int().positive().default(4),
  /** "constant" grids are usable; "dynamic" ones are skipped in v1. */
  grid: z.enum(["constant", "dynamic"]).default("constant"),
});
export type BeatgridExportTrackType = z.infer<typeof BeatgridExportTrackSchema>;

export const BeatgridExportSchema = z.object({
  beatsyncBeatgrids: z.literal(1),
  tracks: z.array(BeatgridExportTrackSchema),
});
export type BeatgridExportType = z.infer<typeof BeatgridExportSchema>;

// ── Name normalization ──────────────────────────────────────────────

/**
 * The name-half of the R2 upload filename pipeline: slashes → "-", sanitized
 * for object keys, truncated, never empty. `generateAudioFileName` (server
 * lib/r2.ts) calls this, and normalizeName applies it to BOTH sides of every
 * match key — so an export-side filename goes through the exact transform its
 * uploaded copy went through (parity by construction). Idempotent, so
 * re-applying it to an already-sanitized room display name is harmless.
 */
export function sanitizeDisplayName(nameWithoutExt: string): string {
  const nameWithoutSlashes = nameWithoutExt.replace(/[/\\]/g, "-");
  let safeName = sanitize(nameWithoutSlashes, { replacement: "*" });
  if (safeName.length > 400) safeName = safeName.substring(0, 400);
  if (!safeName) safeName = "audio";
  return safeName;
}

/**
 * Canonical form of a display name / filename / metadata string for match
 * keys. Strip extension → sanitizer parity → Unicode NFC (Mac browser uploads
 * arrive NFD; DB strings are NFC) → lowercase → fold dash variants → collapse
 * whitespace. Applied identically to both sides of every key, so quirks (e.g.
 * extension-stripping eating ".0" off a title) cancel instead of diverging.
 */
export function normalizeName(name: string): string {
  const withoutExt = name.replace(/\.[^/.]+$/, "");
  return sanitizeDisplayName(withoutExt)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‐‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Human-readable display name embedded in one of our audio URLs: the last
 * path segment, URL-decoded, cut at the `___` uniquifier (uploads) or the
 * extension (default files). Throws on a slashless string.
 */
export function extractDisplayNameFromUrl(url: string): string {
  const parts = url.split("/");
  if (parts.length <= 1) throw new Error(`Invalid URL: ${url}`);
  const fullFileName = decodeURIComponent(parts[parts.length - 1]);
  const delimiterIndex = fullFileName.indexOf(R2_AUDIO_FILE_NAME_DELIMITER);
  if (delimiterIndex !== -1) return fullFileName.substring(0, delimiterIndex);
  return fullFileName.replace(/\.[^/.]+$/, "");
}

// ── Duration tolerances ─────────────────────────────────────────────

/**
 * An exact-key match whose export duration disagrees with the real audio
 * duration by more than this is vetoed — same filename/title but a different
 * version (radio edit vs. extended mix). Generous because provider metadata
 * durations are whole seconds and encoders pad edges slightly.
 */
export const DURATION_VERIFY_TOLERANCE_SEC = 3;

/**
 * Candidate window for the duration+loose-title fallback tier. Tighter than
 * the verify tolerance: here duration is doing identification work, not just
 * vetoing.
 */
export const DURATION_FALLBACK_TOLERANCE_SEC = 1.5;

/**
 * When several candidates share a match key (a collection holding two rips of
 * the same track), the real duration picks one only if it is closer than the
 * runner-up by at least this margin — export durations are whole seconds, so
 * anything under half a second can't discriminate honestly.
 */
export const DURATION_TIEBREAK_MARGIN_SEC = 0.5;

/**
 * Whether two grids are interchangeable for beat-sync: same tempo (±0.05 BPM),
 * same downbeat anchor (±20 ms — beyond that, two "synced" tracks read as a
 * flam), same meter. Used to treat two rips of the same audio as one entry.
 */
export function beatgridsEquivalent(
  a: Pick<BeatgridType, "bpm" | "firstDownbeatSec" | "beatsPerBar">,
  b: Pick<BeatgridType, "bpm" | "firstDownbeatSec" | "beatsPerBar">
): boolean {
  return (
    Math.abs(a.bpm - b.bpm) <= 0.05 &&
    Math.abs(a.firstDownbeatSec - b.firstDownbeatSec) <= 0.02 &&
    a.beatsPerBar === b.beatsPerBar
  );
}

/**
 * Pick the one trustworthy entry out of several claiming the same match key
 * (or surviving the fallback window), or undefined when none can be trusted:
 *   1. a single candidate wins outright;
 *   2. candidates whose grids are all equivalent are the same audio ripped
 *      more than once — any of them works, take the first;
 *   3. genuinely different versions resolve by the real duration, but only
 *      when every candidate has an export duration and the closest one beats
 *      the runner-up by DURATION_TIEBREAK_MARGIN_SEC.
 */
export function resolveBeatgridCandidates(
  candidates: BeatgridExportTrackType[],
  durationSec?: number
): BeatgridExportTrackType | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (candidates.every((c) => beatgridsEquivalent(c, candidates[0]))) return candidates[0];
  if (durationSec !== undefined) {
    const scored = candidates
      .filter((c) => c.durationSec !== undefined)
      .map((c) => ({ c, diff: Math.abs((c.durationSec as number) - durationSec) }))
      .sort((x, y) => x.diff - y.diff);
    // Refuse unless duration can rank EVERY candidate — an unscored entry
    // could be the right one.
    if (scored.length === candidates.length && scored[0].diff + DURATION_TIEBREAK_MARGIN_SEC <= scored[1].diff) {
      return scored[0].c;
    }
  }
  return undefined;
}

// ── Loose title matching (fallback tier only) ───────────────────────

/**
 * Tokens of a display name / title for the loose-title check: normalized,
 * then stripped of the decorations that legitimately differ between a
 * library filename and a room display name — leading track numbers,
 * parenthetical/bracketed qualifiers ("(2019 Remaster)"), and feat. clauses —
 * split on non-alphanumerics. Deliberately structural, not fuzzy: no edit
 * distance, no stemming. Safe ONLY combined with a duration agreement — the
 * "01 - Intro" collision problem disappears when the durations must match.
 */
export function looseNameTokens(name: string): string[] {
  return normalizeName(name)
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ") // parenthetical qualifiers
    .replace(/\b(?:feat|ft|featuring)\b.*$/, " ") // feat. clauses (to end)
    .replace(/^\s*\d+\s*[-._]\s*/, "") // leading track number
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Loose agreement between an export entry and a room display name: every
 * token of the entry's title (filename when untitled) appears among the room
 * name's tokens. Containment, not equality — "Heat 3" agrees with
 * "06 - Shinichi Atobe - Heat 3 (Remastered)".
 */
export function looseTitleMatches(track: BeatgridExportTrackType, roomTokens: ReadonlySet<string>): boolean {
  const tokens = looseNameTokens(track.title?.trim() || track.file);
  return tokens.length > 0 && tokens.every((t) => roomTokens.has(t));
}

// ── Match keys ──────────────────────────────────────────────────────

/**
 * Candidate match keys for one export entry, strongest first:
 *   1. the original filename (uploads keep it),
 *   2. "artist - title" (Navidrome/provider streams are stored under this),
 *   3. bare title (last resort; most collision-prone).
 * Keys claimed by more than one entry are discarded as ambiguous — beat-sync
 * with a wrong grid is worse than no sync, so exact-but-unique or nothing.
 */
export function entryKeys(track: BeatgridExportTrackType): string[] {
  const keys = [normalizeName(track.file)];
  const title = track.title?.trim();
  const artist = track.artist?.trim();
  if (title && artist) keys.push(normalizeName(`${artist} - ${title}`));
  if (title) keys.push(normalizeName(title));
  return keys;
}

// ── Inverted key map (server BeatgridIndex) ─────────────────────────

export interface BeatgridKeyMapResult {
  /**
   * Normalized key → every export entry that claims it. Most keys have one
   * owner; multi-owner keys (a collection holding two rips of the same
   * track) are kept for lookup-time resolution via
   * resolveBeatgridCandidates rather than discarded outright.
   */
  byKey: Map<string, BeatgridExportTrackType[]>;
  /** Constant-grid entries indexed. */
  tracks: number;
  /** Entries skipped because their grid is dynamic (unsupported in v1). */
  skippedDynamic: number;
  /** Keys claimed by more than one entry (resolved at lookup time). */
  ambiguousKeys: number;
}

/**
 * Build the per-track lookup for an export document: every key of every
 * constant-grid entry, with multi-owner keys kept as candidate lists. This is
 * the index-shaped counterpart of matchBeatgridsToTracks — same keys, no
 * per-import claiming (a key resolves the same way however many times it is
 * looked up) — but where the batch matcher discards shared keys, the index
 * defers to resolveBeatgridCandidates, which can settle them with grid
 * equivalence or the track's real duration.
 */
export function buildBeatgridKeyMap(doc: BeatgridExportType): BeatgridKeyMapResult {
  const byKey = new Map<string, BeatgridExportTrackType[]>();
  let tracks = 0;
  let skippedDynamic = 0;
  for (const track of doc.tracks) {
    if (track.grid === "dynamic") {
      skippedDynamic++;
      continue;
    }
    tracks++;
    for (const key of new Set(entryKeys(track))) {
      const list = byKey.get(key);
      if (list) list.push(track);
      else byKey.set(key, [track]);
    }
  }
  let ambiguousKeys = 0;
  for (const list of byKey.values()) {
    if (list.length > 1) ambiguousKeys++;
  }
  return { byKey, tracks, skippedDynamic, ambiguousKeys };
}

/** The compact BeatgridType carried on room tracks, from an export entry. */
export function beatgridFromExportTrack(track: BeatgridExportTrackType): BeatgridType {
  return BeatgridSchema.parse({
    bpm: track.bpm,
    firstBeatSec: track.firstBeatSec,
    firstDownbeatSec: track.firstDownbeatSec,
    beatsPerBar: track.beatsPerBar,
  });
}

/** Field-wise equality of two compact grids (backfill change detection). */
export function beatgridsEqual(a: BeatgridType, b: BeatgridType): boolean {
  return (
    a.bpm === b.bpm &&
    a.firstBeatSec === b.firstBeatSec &&
    a.firstDownbeatSec === b.firstDownbeatSec &&
    a.beatsPerBar === b.beatsPerBar
  );
}

// ── Batch matcher (client manual import) ────────────────────────────

export interface BeatgridMatch {
  url: string;
  beatgrid: BeatgridType;
}

export interface BeatgridMatchResult {
  matches: BeatgridMatch[];
  /** How many matches came from the title/artist fallback (vs filename). */
  matchedByMetadata: number;
  /** Gridded entries in the file that matched no room track. */
  unmatchedFiles: string[];
  /** Entries skipped because their grid is dynamic (unsupported in v1). */
  skippedDynamic: string[];
}

/**
 * Match a beatgrid export against a set of room track URLs: exact on the
 * normalized filename first, then on title/artist metadata (see entryKeys).
 * No fuzzy matching. Every room URL sharing a matched display name gets the
 * grid (the same track can be uploaded or streamed more than once); each URL
 * matches at most one entry.
 */
export function matchBeatgridsToTracks(doc: BeatgridExportType, trackUrls: string[]): BeatgridMatchResult {
  const urlsByName = new Map<string, string[]>(); // normalized display name -> urls
  for (const url of trackUrls) {
    try {
      const name = normalizeName(extractDisplayNameFromUrl(url));
      const list = urlsByName.get(name);
      if (list) list.push(url);
      else urlsByName.set(name, [url]);
    } catch {
      // Unparseable URL — not matchable.
    }
  }

  // A key produced by more than one export entry can't be trusted to identify
  // either of them (e.g. two remixes sharing a bare title).
  const keyOwnerCount = new Map<string, number>();
  for (const track of doc.tracks) {
    if (track.grid === "dynamic") continue;
    for (const key of new Set(entryKeys(track))) {
      keyOwnerCount.set(key, (keyOwnerCount.get(key) ?? 0) + 1);
    }
  }

  const result: BeatgridMatchResult = { matches: [], matchedByMetadata: 0, unmatchedFiles: [], skippedDynamic: [] };
  const claimedUrls = new Set<string>();
  for (const track of doc.tracks) {
    if (track.grid === "dynamic") {
      result.skippedDynamic.push(track.file);
      continue;
    }
    const keys = entryKeys(track);
    let matchedUrls: string[] | undefined;
    let usedKeyIndex = -1;
    for (let i = 0; i < keys.length; i++) {
      if ((keyOwnerCount.get(keys[i]) ?? 0) > 1) continue; // ambiguous key
      const urls = urlsByName.get(keys[i])?.filter((u) => !claimedUrls.has(u));
      if (urls && urls.length > 0) {
        matchedUrls = urls;
        usedKeyIndex = i;
        break;
      }
    }
    if (!matchedUrls) {
      result.unmatchedFiles.push(track.file);
      continue;
    }
    const beatgrid = beatgridFromExportTrack(track);
    for (const url of matchedUrls) {
      claimedUrls.add(url);
      result.matches.push({ url, beatgrid });
    }
    if (usedKeyIndex > 0) result.matchedByMetadata += matchedUrls.length;
  }
  return result;
}
