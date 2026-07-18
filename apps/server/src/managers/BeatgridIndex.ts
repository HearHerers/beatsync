// In-memory index of the Rekordbox beatgrid export (extract_beatgrids.py
// --all) so tracks entering any room get their grid attached automatically —
// no client-side JSON import needed. See BEATGRID_AUTOLOAD_PLAN.md (workspace
// root above this repo).
//
// Loading model: REKORDBOX_BEATGRIDS_PATH names the export JSON on this host.
// Loaded once at startup (fail-open: unset/missing/invalid ⇒ empty index and
// everything else works) and reloaded explicitly via POST
// /admin/beatgrids/reload after each export push. No fs.watch — reload is a
// deliberate step of the sync pipeline (rekordbox-integration/sync_rekordbox_db.sh).
//
// The module-level current index is swapped whole (never mutated), so lookups
// racing a reload see either the old or the new index, both consistent. Tests
// inject via setBeatgridIndex — no module mocking needed.

import {
  beatgridFromExportTrack,
  BeatgridExportSchema,
  buildBeatgridKeyMap,
  DURATION_FALLBACK_TOLERANCE_SEC,
  DURATION_VERIFY_TOLERANCE_SEC,
  extractDisplayNameFromUrl,
  looseNameTokens,
  looseTitleMatches,
  normalizeName,
  resolveBeatgridCandidates,
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
  private readonly byKey: Map<string, BeatgridExportTrackType[]>;
  /** All constant-grid entries — scanned by the duration fallback tier. */
  private readonly entries: BeatgridExportTrackType[];
  readonly tracks: number;
  readonly skippedDynamic: number;
  readonly ambiguousKeys: number;

  constructor(doc: BeatgridExportType | null) {
    if (doc === null) {
      this.byKey = new Map();
      this.entries = [];
      this.tracks = 0;
      this.skippedDynamic = 0;
      this.ambiguousKeys = 0;
      return;
    }
    const { byKey, tracks, skippedDynamic, ambiguousKeys } = buildBeatgridKeyMap(doc);
    this.byKey = byKey;
    this.entries = doc.tracks.filter((t) => t.grid !== "dynamic");
    this.tracks = tracks;
    this.skippedDynamic = skippedDynamic;
    this.ambiguousKeys = ambiguousKeys;
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * Grid for one of our audio URLs, or undefined if the collection has no
   * trustworthy entry for it. Two tiers:
   *
   * 1. Exact key lookup on the normalized display name. Entries whose export
   *    duration disagrees with the real one beyond
   *    DURATION_VERIFY_TOLERANCE_SEC are vetoed (same name, different
   *    version); several survivors — a collection holding two rips of the
   *    same track — go through resolveBeatgridCandidates (equivalent grids
   *    are interchangeable, otherwise the real duration must clearly prefer
   *    one).
   * 2. Duration + loose-title fallback (only when the real duration is
   *    known): entries within DURATION_FALLBACK_TOLERANCE_SEC whose title
   *    tokens all appear in the display name, resolved the same way.
   */
  gridForUrl(url: string, durationSec?: number): BeatgridHit | undefined {
    let name: string;
    try {
      name = normalizeName(extractDisplayNameFromUrl(url));
    } catch {
      return undefined; // unparseable URL — not matchable
    }

    const owners = this.byKey.get(name);
    if (owners) {
      const viable = owners.filter((e) => !durationConflicts(e, durationSec));
      const resolved = resolveBeatgridCandidates(viable, durationSec);
      if (resolved) return toHit(resolved);
    }

    if (durationSec === undefined) return undefined;
    const roomTokens = new Set(looseNameTokens(name));
    const candidates = this.entries.filter(
      (e) =>
        e.durationSec !== undefined &&
        Math.abs(e.durationSec - durationSec) <= DURATION_FALLBACK_TOLERANCE_SEC &&
        looseTitleMatches(e, roomTokens)
    );
    const resolved = resolveBeatgridCandidates(candidates, durationSec);
    return resolved ? toHit(resolved) : undefined;
  }

  /**
   * True when the URL's exact key exists but EVERY owning entry's export
   * duration disagrees with the given real duration — evidence that a grid
   * matched by name alone is for a different version of the track. Used by
   * backfill to DETACH such "auto" grids (mere absence from the index keeps
   * them).
   */
  durationConflict(url: string, durationSec: number): boolean {
    let name: string;
    try {
      name = normalizeName(extractDisplayNameFromUrl(url));
    } catch {
      return false;
    }
    const owners = this.byKey.get(name);
    return owners !== undefined && owners.length > 0 && owners.every((e) => durationConflicts(e, durationSec));
  }
}

function durationConflicts(entry: BeatgridExportTrackType, durationSec: number | undefined): boolean {
  return (
    durationSec !== undefined &&
    entry.durationSec !== undefined &&
    Math.abs(entry.durationSec - durationSec) > DURATION_VERIFY_TOLERANCE_SEC
  );
}

function toHit(entry: BeatgridExportTrackType): BeatgridHit {
  return {
    beatgrid: beatgridFromExportTrack(entry),
    ...(entry.durationSec !== undefined && { durationSec: entry.durationSec }),
    file: entry.file,
  };
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
      (index.ambiguousKeys > 0
        ? `, ${index.ambiguousKeys} key(s) shared by multiple entries (resolved per-lookup)`
        : "")
  );
}
