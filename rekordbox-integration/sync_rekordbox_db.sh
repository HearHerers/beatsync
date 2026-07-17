#!/usr/bin/env bash
# sync_rekordbox_db.sh — push the Rekordbox master.db + ANLZ analysis tree from
# local rekordbox computer to the server so extract_beatgrids.py can run headless there.
#
# Only the database and analysis files are copied — NOT the audio. Beatgrid
# extraction reads master.db + share/ only; the SQLCipher key is bundled in
# pyrekordbox, so the server needs no Rekordbox install.
#
# Rekordbox must be CLOSED while this runs, or the SQLite DB may be captured
# mid-write (a torn copy that fails to open on the server).
#
# Config via env vars (or edit the defaults below):
#   REKORDBOX_SRC_DIR    source dir on the Mac (default: ~/Library/Pioneer/rekordbox)
#   REKORDBOX_SERVER_SSH ~/.ssh/config host alias for the server
#   REKORDBOX_DEST_DIR   dir on the server holding master.db + share/ (default: /srv/rekordbox)
#
# Usage:
#   ./sync_rekordbox_db.sh
#   REKORDBOX_DEST_DIR=/srv/beatgrids ./sync_rekordbox_db.sh
set -euo pipefail

SRC_DIR="${REKORDBOX_SRC_DIR:-$HOME/Library/Pioneer/rekordbox}"
SERVER_SSH="${REKORDBOX_SERVER_SSH}"
DEST_DIR="${REKORDBOX_DEST_DIR}"

# ── Preflight ───────────────────────────────────────────────────────────────
if pgrep -xi rekordbox >/dev/null 2>&1; then
  echo "✗ Rekordbox is running — quit it first (the DB may be mid-write)." >&2
  exit 1
fi

for f in "$SRC_DIR/master.db" "$SRC_DIR/share"; do
  [ -e "$f" ] || { echo "✗ missing on this Mac: $f" >&2; exit 1; }
done

echo "→ src:  $SRC_DIR"
echo "→ dest: $SERVER_SSH:$DEST_DIR   (master.db + share/, no audio)"

# ── Sync ────────────────────────────────────────────────────────────────────
ssh "$SERVER_SSH" "mkdir -p '$DEST_DIR/share'"

# master.db is small — always send a fresh copy.
rsync -avh --progress "$SRC_DIR/master.db" "$SERVER_SSH:$DEST_DIR/master.db"

# masterPlaylists6.xml is optional (silences a pyrekordbox warning); harmless to send.
if [ -f "$SRC_DIR/masterPlaylists6.xml" ]; then
  rsync -avh --progress "$SRC_DIR/masterPlaylists6.xml" "$SERVER_SSH:$DEST_DIR/masterPlaylists6.xml"
fi

# share/ is the ANLZ tree — incremental. --delete prunes analyses removed in
# Rekordbox so the server copy can't go stale. Scoped to share/, which Rekordbox
# owns entirely, so nothing user-authored is at risk.
rsync -avh --delete --progress "$SRC_DIR/share/" "$SERVER_SSH:$DEST_DIR/share/"

echo
echo "✓ synced. On the server run extraction with:"
echo "    REKORDBOX_DB_PATH=$DEST_DIR/master.db \\"
echo "    REKORDBOX_DB_DIR=$DEST_DIR \\"
echo "    python extract_beatgrids.py --all -o beatgrids.json"
