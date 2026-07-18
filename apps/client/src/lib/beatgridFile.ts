// Import of beatgrid data exported by rekordbox-integration/extract_beatgrids.py.
// The matching logic (filename first, then title/artist metadata, ambiguous
// keys discarded) lives in @beatsync/shared — the server's BeatgridIndex uses
// the same primitives for autoload, so manual import and autoload can't
// disagree. This module keeps only the browser File parsing and re-exports
// the matcher for the import UI.

import { BeatgridExportSchema, type BeatgridExportType } from "@beatsync/shared";

export {
  matchBeatgridsToTracks,
  type BeatgridExportType,
  type BeatgridMatch,
  type BeatgridMatchResult,
} from "@beatsync/shared";

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
