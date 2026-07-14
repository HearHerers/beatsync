# Rekordbox integration

Tooling that pulls beatgrid data out of a local Rekordbox 6 collection so
beatsync map rooms can beat-match two zones (master/follower tempo sync via
`playbackRate`). This reads `master.db` **and** the per-track ANLZ analysis
files via [pyrekordbox](https://github.com/dylanljones/pyrekordbox) — exact
per-beat ground truth, no XML export step.

## Requirements

- Rekordbox 6 installed locally (the script reads its DB in place)
- Python 3.11+ with `pyrekordbox` and `numpy` (`pip install -r requirements.txt`)
- Rekordbox closed while extracting (the DB may be locked otherwise)

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
