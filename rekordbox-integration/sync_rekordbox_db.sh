#!/usr/bin/env bash
# sync_rekordbox_db.sh — push beatgrid data from the local Rekordbox computer
# to the beatsync server.
#
# Default path (extraction runs locally):
#   1. python extract_beatgrids.py --all        → beatgrids.json (next to this script)
#   2. ./sync_rekordbox_db.sh                   → rsync beatgrids.json to the server
#      and, when BEATSYNC_SERVER_URL + OPERATOR_SECRET are set, POST
#      /admin/beatgrids/reload so the running server re-matches every room's
#      tracks immediately. Otherwise the file is picked up on next server start
#      (the server's REKORDBOX_BEATGRIDS_PATH must point at the pushed file).
#
# Alternative (--db): also push master.db + the share/ ANLZ tree so
# extract_beatgrids.py can run headless ON the server instead. Only the
# database and analysis files are copied — NOT the audio; the SQLCipher key is
# bundled in pyrekordbox, so the server needs no Rekordbox install. Rekordbox
# must be CLOSED for --db (the SQLite DB may be captured mid-write otherwise).
#
# Config via env vars (or edit the defaults below):
#   REKORDBOX_SERVER_SSH      ~/.ssh/config host alias for the server (required)
#   REKORDBOX_DEST_DIR        destination dir on the server (required)
#   REKORDBOX_BEATGRIDS_JSON  local export to push (default: ./beatgrids.json)
#   BEATSYNC_SERVER_URL       base URL of the running beatsync server (optional)
#   OPERATOR_SECRET           the beatsync /admin/* bearer (optional)
#   REKORDBOX_SRC_DIR         --db only: local Rekordbox dir
#                             (default: ~/Library/Pioneer/rekordbox)
#
# Usage:
#   ./sync_rekordbox_db.sh          # push beatgrids.json (+ hot reload)
#   ./sync_rekordbox_db.sh --db     # also push master.db + share/ for remote extraction
set -euo pipefail

SYNC_DB=0
if [ "${1:-}" = "--db" ]; then
  SYNC_DB=1
elif [ -n "${1:-}" ]; then
  echo "✗ unknown argument: $1 (only --db is supported)" >&2
  exit 1
fi

SERVER_SSH="${REKORDBOX_SERVER_SSH:?set REKORDBOX_SERVER_SSH to the ssh host alias of the server}"
DEST_DIR="${REKORDBOX_DEST_DIR:?set REKORDBOX_DEST_DIR to the destination dir on the server}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BEATGRIDS_JSON="${REKORDBOX_BEATGRIDS_JSON:-$SCRIPT_DIR/beatgrids.json}"

# ── Beatgrid export push (the default path) ─────────────────────────────────
if [ ! -f "$BEATGRIDS_JSON" ]; then
  echo "✗ no $BEATGRIDS_JSON — run extraction first:" >&2
  echo "    python extract_beatgrids.py --all -o $BEATGRIDS_JSON" >&2
  [ "$SYNC_DB" = 1 ] || exit 1
  echo "  (continuing with --db sync only)" >&2
else
  echo "→ push: $BEATGRIDS_JSON → $SERVER_SSH:$DEST_DIR/beatgrids.json"
  ssh "$SERVER_SSH" "mkdir -p '$DEST_DIR'"
  rsync -avh --progress "$BEATGRIDS_JSON" "$SERVER_SSH:$DEST_DIR/beatgrids.json"
  if [ -n "${BEATSYNC_SERVER_URL:-}" ] && [ -n "${OPERATOR_SECRET:-}" ]; then
    echo "→ POST $BEATSYNC_SERVER_URL/admin/beatgrids/reload"
    curl -fsS -X POST -H "Authorization: Bearer $OPERATOR_SECRET" \
      "$BEATSYNC_SERVER_URL/admin/beatgrids/reload"
    echo
  else
    echo "ℹ beatgrids.json pushed; set BEATSYNC_SERVER_URL + OPERATOR_SECRET to hot-reload the server."
  fi
fi

# ── DB + ANLZ push (--db: for extraction on the server) ─────────────────────
if [ "$SYNC_DB" = 1 ]; then
  SRC_DIR="${REKORDBOX_SRC_DIR:-$HOME/Library/Pioneer/rekordbox}"

  if pgrep -xi rekordbox >/dev/null 2>&1; then
    echo "✗ Rekordbox is running — quit it first (the DB may be mid-write)." >&2
    exit 1
  fi

  for f in "$SRC_DIR/master.db" "$SRC_DIR/share"; do
    [ -e "$f" ] || { echo "✗ missing locally: $f" >&2; exit 1; }
  done

  echo "→ src:  $SRC_DIR"
  echo "→ dest: $SERVER_SSH:$DEST_DIR   (master.db + share/, no audio)"

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
  echo "✓ DB synced. To (re)extract on the server:"
  echo "    REKORDBOX_DB_PATH=$DEST_DIR/master.db \\"
  echo "    REKORDBOX_DB_DIR=$DEST_DIR \\"
  echo "    python extract_beatgrids.py --all -o beatgrids.json"
fi

echo
echo "✓ done"
