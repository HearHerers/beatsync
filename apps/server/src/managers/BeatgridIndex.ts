// In-memory index of the Rekordbox beatgrid export (extract_beatgrids.py
// --all) so tracks entering any room get their grid attached automatically —
// no client-side JSON import needed. See BEATGRID_AUTOLOAD_PLAN.md (workspace
// root above this repo).
//
// Loading model: REKORDBOX_BEATGRIDS_PATH names the export JSON on this host.
// Loaded once at startup (fail-open: unset/missing/invalid ⇒ empty index and
// everything else works) and reloaded explicitly via POST
// /admin/beatgrids/reload after each DB sync. No fs.watch — reload is a
// deliberate step of the sync pipeline (rekordbox-integration/post_sync.sh).
//
// The module-level current index is swapped whole (never mutated), so lookups
// racing a reload see either the old or the new index, both consistent. Tests
// inject via setBeatgridIndex — no module mocking needed.

import {
  beatgridFromExportTrack,
  BeatgridExportSchema,
  buildBeatgridKeyMap,
  extractDisplayNameFromUrl,
  normalizeName,
  type BeatgridExportTrackType,
  type BeatgridExportType,
  type BeatgridType,
} from "@beatsync/shared";
import { readFileSync } from "node:fs";

export interface BeatgridHit {
  beatgrid: BeatgridType;
  /** Export-side track length (seconds), for future duration sanity checks. */
  durationSec?: number;
  /** Export-side filename, for logging. */
  file: string;
}

export class BeatgridIndex {
  private readonly byKey: Map<string, BeatgridExportTrackType>;
  readonly tracks: number;
  readonly skippedDynamic: number;
  readonly ambiguousKeys: number;

  constructor(doc: BeatgridExportType | null) {
    if (doc === null) {
      this.byKey = new Map();
      this.tracks = 0;
      this.skippedDynamic = 0;
      this.ambiguousKeys = 0;
      return;
    }
    const { byKey, tracks, skippedDynamic, ambiguousKeys } = buildBeatgridKeyMap(doc);
    this.byKey = byKey;
    this.tracks = tracks;
    this.skippedDynamic = skippedDynamic;
    this.ambiguousKeys = ambiguousKeys;
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Grid for one of our audio URLs, or undefined if the collection has no
   *  unambiguous entry for its display name. */
  gridForUrl(url: string): BeatgridHit | undefined {
    let name: string;
    try {
      name = normalizeName(extractDisplayNameFromUrl(url));
    } catch {
      return undefined; // unparseable URL — not matchable
    }
    const entry = this.byKey.get(name);
    if (!entry) return undefined;
    return {
      beatgrid: beatgridFromExportTrack(entry),
      ...(entry.durationSec !== undefined && { durationSec: entry.durationSec }),
      file: entry.file,
    };
  }
}

const EMPTY_INDEX = new BeatgridIndex(null);
let current: BeatgridIndex = EMPTY_INDEX;

export function getBeatgridIndex(): BeatgridIndex {
  return current;
}

/** Test seam (and loader target): swap the active index. */
export function setBeatgridIndex(index: BeatgridIndex): void {
  current = index;
}

export type BeatgridLoadResult = { ok: true; path: string; index: BeatgridIndex } | { ok: false; error: string };

/**
 * Parse + validate an export file into an index. Pure with respect to the
 * module state — callers decide whether to install the result (startup does,
 * a failed reload keeps the previous index).
 */
export function loadBeatgridIndexFromFile(path: string): BeatgridLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return { ok: false, error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = BeatgridExportSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `${path} is not an extract_beatgrids.py export (beatsyncBeatgrids: 1)` };
  }
  return { ok: true, path, index: new BeatgridIndex(parsed.data) };
}

/**
 * Startup load from REKORDBOX_BEATGRIDS_PATH. Fail-open — any problem leaves
 * the empty index in place — but LOUD either way: a silently empty index is
 * indistinguishable from "no grids in the collection" when debugging.
 */
export function loadBeatgridIndexFromEnv(): void {
  const path = process.env.REKORDBOX_BEATGRIDS_PATH;
  if (!path) {
    console.log("ℹ️  REKORDBOX_BEATGRIDS_PATH not set; beatgrid autoload disabled (manual import still works).");
    return;
  }
  const result = loadBeatgridIndexFromFile(path);
  if (!result.ok) {
    console.error(`⚠️  Beatgrid autoload failed (${result.error}); continuing with an empty index.`);
    return;
  }
  setBeatgridIndex(result.index);
  logIndexStats(result.index, path);
}

/**
 * Explicit reload for POST /admin/beatgrids/reload. On failure the previous
 * index stays active and the error is reported to the caller.
 */
export function reloadBeatgridIndex(): BeatgridLoadResult {
  const path = process.env.REKORDBOX_BEATGRIDS_PATH;
  if (!path) return { ok: false, error: "REKORDBOX_BEATGRIDS_PATH not set" };
  const result = loadBeatgridIndexFromFile(path);
  if (result.ok) {
    setBeatgridIndex(result.index);
    logIndexStats(result.index, path);
  }
  return result;
}

function logIndexStats(index: BeatgridIndex, path: string): void {
  console.log(
    `🎚️  Beatgrid index loaded from ${path}: ${index.tracks} track(s), ${index.size} key(s)` +
      (index.skippedDynamic > 0 ? `, ${index.skippedDynamic} dynamic skipped` : "") +
      (index.ambiguousKeys > 0 ? `, ${index.ambiguousKeys} ambiguous key(s) discarded` : "")
  );
}
