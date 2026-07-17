#!/usr/bin/env python3
"""Extract beatgrid data from a local Rekordbox 6 collection for beatsync zone-sync.

Reads master.db + the per-track ANLZ analysis files via pyrekordbox and emits a
JSON document of compact beatgrids, keyed by audio filename. beatsync matches
tracks by filename because its R2 keys embed the sanitized original name
(`room-{id}/{name}☆{timestamp}.{ext}`).

The compact form is `{bpm, firstBeatSec, firstDownbeatSec, beatsPerBar}` — a
constant-tempo model anchored at the first downbeat. The script validates that
model against the full per-beat ANLZ grid and reports the worst-case error; if
the grid is genuinely dynamic (multiple tempos, or the constant model drifts
more than DYNAMIC_GRID_ERR_MS), the full tempo markers are included instead of
silently exporting a grid that would walk out of phase.

Usage:
    python extract_beatgrids.py --filter "Heat 3" --filter "Bump Talkin"
    python extract_beatgrids.py --folder ~/Music/rekordbox/
    python extract_beatgrids.py --all -o beatgrids.json

Rekordbox should be closed while this runs (the DB may be locked otherwise).
"""

import argparse
import json
import os
import sys
import time

import numpy as np
try:  # pyrekordbox >= 0.4.5.dev (new layout)
    from pyrekordbox import MasterDatabase
    from pyrekordbox.masterdb.models import DjmdContent
except ImportError:  # pyrekordbox <= 0.4.4 (installed here)
    from pyrekordbox import Rekordbox6Database as MasterDatabase
    from pyrekordbox.db6.tables import DjmdContent
import logging
logging.getLogger("pyrekordbox").setLevel(logging.ERROR)

# Above this worst-case deviation between the constant-BPM model and the actual
# per-beat grid, the track is treated as dynamic-tempo and full markers are
# exported. ~30ms is where two beats start reading as a flam rather than one hit.
DYNAMIC_GRID_ERR_MS = 15.0

EXPORT_VERSION = 1


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def read_beat_grid(db: MasterDatabase, content: DjmdContent):
    """Return (beat_in_bar, bpm, time_sec) numpy arrays, or None if unanalyzed."""
    try:
        anlz_files = db.read_anlz_files(content.ID)
    except Exception as e:  # missing/corrupt ANLZ path
        log(f"  ! ANLZ read failed for {content.Title!r}: {e!r}")
        return None
    for _path, anlz in anlz_files.items():
        try:
            grid = anlz.get("beat_grid")
        except (IndexError, KeyError):
            continue  # this ANLZ file (e.g. .EXT) has no beat-grid tag
        if grid is not None:
            beat_num, bpm_arr, t = (np.asarray(a) for a in grid)
            if len(t) >= 2:
                return beat_num, bpm_arr.astype(float), t.astype(float)
    return None


def build_track_entry(db: MasterDatabase, content: DjmdContent):
    grid = read_beat_grid(db, content)
    if grid is None:
        log(f"  ! no beatgrid for {content.Title!r} — skipping (not analyzed in Rekordbox?)")
        return None
    beat_num, bpm_arr, t = grid

    headline_bpm = (content.BPM or 0) / 100.0
    if headline_bpm <= 0:
        log(f"  ! no BPM in DB for {content.Title!r} — skipping")
        return None

    downbeat_idx = int(np.argmax(beat_num == 1)) if np.any(beat_num == 1) else 0
    first_downbeat = float(t[downbeat_idx])

    # Validate the constant-tempo model: predicted beat k = downbeat + k * 60/bpm.
    k = np.arange(len(t)) - downbeat_idx
    err_ms = (t - (first_downbeat + k * (60.0 / headline_bpm))) * 1000.0
    max_err_ms = float(np.abs(err_ms).max())

    unique_bpms = sorted({round(float(b), 2) for b in bpm_arr})
    is_dynamic = len(unique_bpms) > 1 or max_err_ms > DYNAMIC_GRID_ERR_MS

    entry = {
        "file": os.path.basename(content.FolderPath),
        "title": content.Title,
        "artist": content.Artist.Name if content.Artist else None,
        "bpm": headline_bpm,
        "firstBeatSec": round(float(t[0]), 4),
        "firstDownbeatSec": round(first_downbeat, 4),
        "beatsPerBar": 4,
        "grid": "dynamic" if is_dynamic else "constant",
        "numBeats": int(len(t)),
        "constGridMaxErrMs": round(max_err_ms, 1),
    }

    if is_dynamic:
        # Tempo markers: the first beat plus every beat where the BPM changes.
        # Consumers re-anchor at each marker instead of trusting one global BPM.
        change = np.flatnonzero(np.diff(bpm_arr) != 0) + 1
        idxs = np.concatenate(([0], change))
        entry["markers"] = [
            {
                "timeSec": round(float(t[i]), 4),
                "bpm": round(float(bpm_arr[i]), 2),
                "beatInBar": int(beat_num[i]),
            }
            for i in idxs
        ]
        log(
            f"  ~ {content.Title!r} has a DYNAMIC grid "
            f"({len(unique_bpms)} tempos, const-model err {max_err_ms:.1f}ms) — "
            f"exported {len(entry['markers'])} markers"
        )
    return entry


def pick_preferred(rows, prefer_prefix):
    """Dedupe DB rows that share a filename (e.g. a local copy + an NFS copy)."""
    by_file = {}
    for c in rows:
        by_file.setdefault(os.path.basename(c.FolderPath), []).append(c)
    picked = []
    for fname, cands in by_file.items():
        if len(cands) > 1:
            cands.sort(
                key=lambda c: (
                    not (prefer_prefix and c.FolderPath.startswith(prefer_prefix)),
                    not os.path.exists(c.FolderPath),
                )
            )
            dropped = ", ".join(c.FolderPath for c in cands[1:])
            log(f"  ~ {fname}: {len(cands)} DB entries, using {cands[0].FolderPath} (skipped: {dropped})")
        picked.append(cands[0])
    return picked


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    sel = ap.add_argument_group("track selection (at least one required)")
    sel.add_argument("--filter", action="append", default=[], metavar="TEXT", help="title substring; repeatable")
    sel.add_argument("--folder", metavar="PREFIX", help="only tracks whose file path starts with this prefix; also preferred when deduping")
    sel.add_argument("--all", action="store_true", help="the entire collection")
    ap.add_argument("-o", "--output", default="beatgrids.json", help="output path (default: %(default)s)")
    src = ap.add_argument_group("database location (for running against a copied DB, e.g. a server)")
    src.add_argument(
        "--db-path",
        default=os.environ.get("REKORDBOX_DB_PATH"),
        metavar="FILE",
        help="path to master.db (env: REKORDBOX_DB_PATH). Omit to auto-detect a local Rekordbox install.",
    )
    src.add_argument(
        "--db-dir",
        default=os.environ.get("REKORDBOX_DB_DIR", ""),
        metavar="DIR",
        help="directory holding master.db and the share/ ANLZ tree (env: REKORDBOX_DB_DIR). "
        "Defaults to the parent of --db-path.",
    )
    args = ap.parse_args()

    if not (args.filter or args.folder or args.all):
        ap.error("select tracks with --filter, --folder, or --all")

    # With no explicit path/dir this falls back to pyrekordbox auto-detection of a
    # local Rekordbox install (the Mac case). On a server with only a copied DB,
    # point --db-dir (or REKORDBOX_DB_DIR) at the directory that holds both
    # master.db and share/ — the SQLCipher key is bundled in pyrekordbox, so no
    # Rekordbox install is needed. See README ("Running against a copied DB").
    db = MasterDatabase(path=args.db_path or None, db_dir=args.db_dir)
    q = db.query(DjmdContent)
    if args.folder:
        q = q.filter(DjmdContent.FolderPath.startswith(args.folder))
    rows = q.all()
    if args.filter:
        rows = [c for c in rows if any(f.lower() in (c.Title or "").lower() for f in args.filter)]

    if not rows:
        log("No matching tracks in the Rekordbox DB.")
        return 1

    log(f"Matched {len(rows)} DB entries")
    tracks = []
    for content in pick_preferred(rows, args.folder):
        entry = build_track_entry(db, content)
        if entry:
            tracks.append(entry)
            log(f"  ✓ {entry['file']}: {entry['bpm']} BPM, downbeat {entry['firstDownbeatSec']}s, {entry['grid']} (err ≤ {entry['constGridMaxErrMs']}ms)")
    db.close()

    doc = {
        "beatsyncBeatgrids": EXPORT_VERSION,
        "exportedAt": int(time.time() * 1000),
        "tracks": sorted(tracks, key=lambda e: e["file"].lower()),
    }
    with open(args.output, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    log(f"Wrote {len(tracks)} beatgrids to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
