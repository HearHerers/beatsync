# Rekordbox integration

Tooling that pulls beatgrid data out of a local Rekordbox 6 collection so
beatsync map rooms can beat-match two zones (master/follower tempo sync via
`playbackRate`). This reads `master.db` **and** the per-track ANLZ analysis
files via [pyrekordbox](https://github.com/dylanljones/pyrekordbox) — exact
per-beat ground truth, no XML export step.
- **NOTE**: Easiest route is to extract full db via `python extract_beatgrids.py --all -o beatgrids.json`

## Requirements

- Rekordbox 6 to **analyze** the tracks (it computes the beatgrids this reads).
  Extraction itself only needs the resulting `master.db` + `share/` files — see
  [Running against a copied DB](#running-against-a-copied-db-headless--server).
- Python 3.11+ with `pyrekordbox`, `numpy`, and `sqlcipher3-wheels`
  (`pip install -r requirements.txt` — the last is a pyrekordbox dependency that
  unlocks the encrypted DB and bundles its own libsqlcipher, so no system package
  is needed).
- Rekordbox closed while extracting (the DB may be locked otherwise).

An existing venv with these installed lives at
`~/Documents/personal/sound/rekordbox/env` (the Roon→Rekordbox sync tooling).

## Usage

```bash
python extract_beatgrids.py --filter "Heat 3" --filter "Bump Talkin"
python extract_beatgrids.py --folder ~/Music/rekordbox/
python extract_beatgrids.py --all -o beatgrids.json
```

Tracks are keyed by **filename** in the output, because beatsync's R2 keys
embed the sanitized original filename (`room-{id}/{name}☆{timestamp}.{ext}`) —
that's the join key between a beatgrid and an uploaded track. Duplicate DB
entries for the same filename (e.g. a local copy plus an NFS copy) are deduped,
preferring the `--folder` prefix, then paths that exist on disk.

## Running against a copied DB (headless / server)

Extraction reads only two static artifacts — `master.db` and the `share/` ANLZ
tree — and pyrekordbox ships the SQLCipher key itself. So the audio files are
never opened and **no Rekordbox install is required** on the extracting machine.
That lets extraction run unattended on a server; only the analysis step upstream
still needs the Rekordbox app.

Point the script at a copied DB with two options (or their env vars):

| Option | Env var | Meaning |
|---|---|---|
| `--db-path` | `REKORDBOX_DB_PATH` | path to the copied `master.db` |
| `--db-dir` | `REKORDBOX_DB_DIR` | directory holding `master.db` **and** `share/` |

Set **both** on a server — `--db-dir` alone leaves the DB path unset, which falls
back to auto-detecting a local Rekordbox install and fails on a headless box.
With neither set, the script auto-detects a local install,
unchanged.

Where to put the env vars: prefer a systemd unit / cron `EnvironmentFile` for an
unattended job (keeps config scoped to the job rather than an interactive shell
profile).

### Workflow

```
Rekordbox: analyze tracks, quit the app
        │  ./sync_rekordbox_db.sh   (rsync master.db + share/, no audio)
        ▼
Server: extract_beatgrids.py  →  beatgrids.json     (headless, automatable)
```

`sync_rekordbox_db.sh` pushes `master.db` + `share/` from
`~/Library/Pioneer/rekordbox` to the server (config via `REKORDBOX_SRC_DIR`,
`REKORDBOX_SERVER_SSH`, `REKORDBOX_DEST_DIR`; refuses to run while Rekordbox is
open). Then on the server:

```bash
REKORDBOX_DB_PATH=/srv/rekordbox/master.db \
REKORDBOX_DB_DIR=/srv/rekordbox \
python extract_beatgrids.py --all -o beatgrids.json
```

The exported `beatgrids.json` is only as current as the last sync — re-run
`sync_rekordbox_db.sh` after analyzing new tracks.

## Output format

```json
{
  "beatsyncBeatgrids": 1,
  "exportedAt": 1770000000000,
  "tracks": [
    {
      "file": "06 - Shinichi Atobe - Heat 3.flac",
      "title": "Heat 3",
      "artist": "Shinichi Atobe",
      "bpm": 123.0,
      "firstBeatSec": 0.052,
      "firstDownbeatSec": 0.052,
      "beatsPerBar": 4,
      "grid": "constant",
      "numBeats": 1184,
      "constGridMaxErrMs": 3.3
    }
  ]
}
```

- `bpm` + `firstDownbeatSec` are the two numbers zone-sync actually consumes:
  follower rate = `bpm_master / bpm_follower`, and phase anchors compute from
  the downbeat. `beatsPerBar` enables bar-quantized (vs beat-quantized) sync.
- `constGridMaxErrMs` is the validation result: worst-case deviation of the
  constant-tempo model from the real per-beat ANLZ grid over the whole track.
  Values of a few ms are ANLZ's 1 ms time quantization, not real drift.
- `grid: "dynamic"` means the constant model was rejected (multiple tempos or
  error > 15 ms). Those tracks carry a `markers` array
  (`{timeSec, bpm, beatInBar}` at each tempo change) and consumers must
  re-anchor at markers instead of trusting one global BPM. Quantized
  house/techno is virtually always `constant`; live-drummer material
  (disco, funk) is where `dynamic` shows up.

## How it validates

For each track the script rebuilds the ideal grid from
`firstDownbeatSec + k · 60/bpm` and compares it against every actual ANLZ beat
timestamp. Reference measurements on this collection: Heat 3 (123 BPM, 1184
beats, 9.6 min) deviates ≤ 3.3 ms; Bump Talkin (132.4 BPM, 683 beats) ≤ 4.0 ms.
A 0.1 BPM grid error at ~124 would accumulate ~30 ms over six minutes — so this
check is what decides whether the compact format is safe per track.
