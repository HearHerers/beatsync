// Import of beatgrid data exported by rekordbox-integration/extract_beatgrids.py.
// The file is keyed by audio filename; we match those against room track URLs
// (whose R2 keys embed the sanitized original name) and emit one
// SET_TRACK_BEATGRID per match.

import { extractFileNameFromUrl } from "@/lib/utils";
import { BeatgridSchema, type BeatgridType } from "@beatsync/shared";
import { z } from "zod";

/** Format emitted by rekordbox-integration/extract_beatgrids.py. */
const BeatgridExportTrackSchema = z.object({
  file: z.string(),
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

export interface BeatgridMatch {
  url: string;
  beatgrid: BeatgridType;
}

export interface BeatgridMatchResult {
  matches: BeatgridMatch[];
  /** Gridded entries in the file that matched no room track. */
  unmatchedFiles: string[];
  /** Entries skipped because their grid is dynamic (unsupported in v1). */
  skippedDynamic: string[];
}

/**
 * Match a beatgrid export against a set of room track URLs by filename.
 * Matching is exact on the normalized (extension-less, lowercased) name —
 * beat-sync with a wrong grid is worse than no sync, so no fuzzy fallback.
 */
export function matchBeatgridsToTracks(doc: BeatgridExportType, trackUrls: string[]): BeatgridMatchResult {
  const byName = new Map<string, string>(); // normalized display name -> url
  for (const url of trackUrls) {
    try {
      byName.set(normalizeName(extractFileNameFromUrl(url)), url);
    } catch {
      // Unparseable URL — not matchable.
    }
  }

  const result: BeatgridMatchResult = { matches: [], unmatchedFiles: [], skippedDynamic: [] };
  for (const track of doc.tracks) {
    if (track.grid === "dynamic") {
      result.skippedDynamic.push(track.file);
      continue;
    }
    const url = byName.get(normalizeName(track.file));
    if (!url) {
      result.unmatchedFiles.push(track.file);
      continue;
    }
    result.matches.push({
      url,
      beatgrid: BeatgridSchema.parse({
        bpm: track.bpm,
        firstBeatSec: track.firstBeatSec,
        firstDownbeatSec: track.firstDownbeatSec,
        beatsPerBar: track.beatsPerBar,
      }),
    });
  }
  return result;
}
