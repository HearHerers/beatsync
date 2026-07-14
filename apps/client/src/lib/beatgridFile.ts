// Import of beatgrid data exported by rekordbox-integration/extract_beatgrids.py.
// Entries match against room track URLs (whose R2 keys embed the sanitized
// display name) first by filename, then by title/artist metadata — the latter
// covers provider-streamed tracks (e.g. Navidrome), which are stored under an
// "Artist - Title" display name that never matches the original filename.
// One SET_TRACK_BEATGRID is emitted per matched URL.

import { extractFileNameFromUrl } from "@/lib/utils";
import { BeatgridSchema, type BeatgridType } from "@beatsync/shared";
import { z } from "zod";

/** Format emitted by rekordbox-integration/extract_beatgrids.py. */
const BeatgridExportTrackSchema = z.object({
  file: z.string(),
  /** Track metadata from the DJ library — used as a matching fallback. */
  title: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  bpm: z.number().positive(),
  firstBeatSec: z.number().min(0),
  firstDownbeatSec: z.number().min(0),
  beatsPerBar: z.number().int().positive().default(4),
  /** "constant" grids are usable; "dynamic" ones are skipped in v1. */
  grid: z.enum(["constant", "dynamic"]).default("constant"),
});

const BeatgridExportSchema = z.object({
  beatsyncBeatgrids: z.literal(1),
  tracks: z.array(BeatgridExportTrackSchema),
});
export type BeatgridExportType = z.infer<typeof BeatgridExportSchema>;

/**
 * Read + validate a beatgrids.json file. Throws (with a human-readable message)
 * on malformed JSON or a schema mismatch.
 */
export async function parseBeatgridFile(file: File): Promise<BeatgridExportType> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  const result = BeatgridExportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("Not a Beatsync beatgrids file (expected extract_beatgrids.py output).");
  }
  return result.data;
}

/** Strip extension + lowercase, the common form between the export's `file`
 *  field and extractFileNameFromUrl's sanitized display name. */
function normalizeName(name: string): string {
  return name
    .replace(/\.[^/.]+$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Candidate match keys for one export entry, strongest first:
 *   1. the original filename (uploads keep it),
 *   2. "artist - title" (Navidrome/provider streams are stored under this),
 *   3. bare title (last resort; most collision-prone).
 * Keys claimed by more than one entry are discarded as ambiguous — beat-sync
 * with a wrong grid is worse than no sync, so exact-but-unique or nothing.
 */
function entryKeys(track: z.infer<typeof BeatgridExportTrackSchema>): string[] {
  const keys = [normalizeName(track.file)];
  const title = track.title?.trim();
  const artist = track.artist?.trim();
  if (title && artist) keys.push(normalizeName(`${artist} - ${title}`));
  if (title) keys.push(normalizeName(title));
  return keys;
}

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
      const name = normalizeName(extractFileNameFromUrl(url));
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
    const beatgrid = BeatgridSchema.parse({
      bpm: track.bpm,
      firstBeatSec: track.firstBeatSec,
      firstDownbeatSec: track.firstDownbeatSec,
      beatsPerBar: track.beatsPerBar,
    });
    for (const url of matchedUrls) {
      claimedUrls.add(url);
      result.matches.push({ url, beatgrid });
    }
    if (usedKeyIndex > 0) result.matchedByMetadata += matchedUrls.length;
  }
  return result;
}
