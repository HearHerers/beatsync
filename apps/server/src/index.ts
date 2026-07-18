import { ADMIN_SECRET, IS_DEMO_MODE } from "@/demo";
import { validateR2Config } from "@/lib/r2";
import { globalManager } from "@/managers";
import { BackupManager } from "@/managers/BackupManager";
import { getBeatgridIndex, loadBeatgridIndexFromEnv } from "@/managers/BeatgridIndex";
import { getActiveRooms } from "@/routes/active";
import { handleAdmin } from "@/routes/admin";
import { handleGetDefaultAudio } from "@/routes/default";
import { handleServeAudio } from "@/routes/demoAudio";
import { handleDiscover } from "@/routes/discover";
import { handleRoot } from "@/routes/root";
import { handleStats } from "@/routes/stats";
import { handleGetPresignedURL, handleUploadComplete } from "@/routes/upload";
import { handleWebSocketUpgrade } from "@/routes/websocket";
import { handleClose, handleMessage, handleOpen } from "@/routes/websocketHandlers";
import { corsHeaders, errorResponse } from "@/utils/responses";
import type { WSData } from "@/utils/websocket";

// Whether R2 (durable state) is configured. Computed once and reused for the
// post-listen periodic backup.
const r2Valid = !IS_DEMO_MODE && validateR2Config().isValid;

// Restore persisted state BEFORE accepting any connections. Otherwise a client
// could connect during the async restore window and hit a not-yet-restored
// (empty) room — recreating it fresh and clobbering durable state. Rooms are
// permanent, so getting this right matters.
// Load the Rekordbox beatgrid index (REKORDBOX_BEATGRIDS_PATH; fail-open)
// before restore so the post-restore backfill below has it.
loadBeatgridIndexFromEnv();

if (r2Valid) {
  try {
    await BackupManager.restoreState();
  } catch (error) {
    console.error("Failed to restore state on startup:", error);
  }
} else if (!IS_DEMO_MODE) {
  console.log("ℹ️  R2 not configured; skipping state restore (state will not persist).");
}

// Backfill beatgrids onto restored tracks. Restore sets playlists directly
// (restorePlaylists), bypassing addTrackToContext's auto-attach hook — without
// this sweep, everything already in rooms at boot would stay ungridded. Runs
// before listen, so no client can observe the pre-backfill state.
if (getBeatgridIndex().size > 0) {
  let changedTracks = 0;
  let changedRooms = 0;
  globalManager.forEachRoom((room) => {
    const n = room.backfillBeatgrids();
    if (n > 0) {
      changedTracks += n;
      changedRooms++;
    }
  });
  if (changedTracks > 0) {
    console.log(
      `🎚️  Beatgrid backfill: attached/updated ${changedTracks} track entr(ies) across ${changedRooms} room(s).`
    );
  }
}

// Bun.serve with WebSocket support
const server = Bun.serve<WSData>({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT) || 8080,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Operator surface (fail-closed 404 without OPERATOR_SECRET; no CORS).
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        return await handleAdmin(req, url, server);
      }

      // Demo mode: serve local audio files
      if (IS_DEMO_MODE && url.pathname.startsWith("/audio/")) {
        return handleServeAudio(url.pathname);
      }

      switch (url.pathname) {
        case "/":
          return handleRoot(req);

        case "/ws":
          return handleWebSocketUpgrade(req, server);

        case "/upload/get-presigned-url":
          if (IS_DEMO_MODE) return errorResponse("Uploads disabled in demo mode", 403);
          return handleGetPresignedURL(req);

        case "/upload/complete":
          if (IS_DEMO_MODE) return errorResponse("Uploads disabled in demo mode", 403);
          return handleUploadComplete(req, server);

        case "/stats":
          return handleStats();

        case "/default":
          return handleGetDefaultAudio(req);

        case "/active-rooms":
          return getActiveRooms(req);

        case "/discover":
          return handleDiscover(req);

        default:
          return errorResponse("Not found", 404);
      }
    } catch {
      return errorResponse("Internal server error", 500);
    }
  },

  websocket: {
    open(ws) {
      handleOpen(ws, server);
    },

    message(ws, message) {
      void handleMessage(ws, message, server);
    },

    close(ws) {
      handleClose(ws, server);
    },
  },
});

console.log(`HTTP listening on http://${server.hostname}:${server.port}`);

if (IS_DEMO_MODE) {
  console.log(`🔑 Admin secret: ${ADMIN_SECRET}`);
}

if (r2Valid && BackupManager.lastRestoreFailed) {
  // Restore hit a hard failure (couldn't read/parse the backup). Do NOT start
  // periodic backups — the current state is empty, and backing it up would
  // overwrite and prune the good backups we failed to read (#124/1). Leave the
  // data intact for investigation; a fixed restart will pick it back up.
  console.error(
    "⛔ Skipping periodic backups: state restore FAILED. Refusing to overwrite existing R2 backups with empty state. Investigate and restart."
  );
} else if (r2Valid) {
  // Periodic safety-net backup (restore already ran before listen, above).
  const BACKUP_INTERVAL_MS = 60 * 1000;
  setInterval(() => {
    BackupManager.backupState().catch((error) => {
      console.error("Failed to perform periodic backup:", error);
    });
  }, BACKUP_INTERVAL_MS);
}

// Simple graceful shutdown
const shutdown = async () => {
  console.log("\n⚠️ Shutting down...");

  void server.stop(); // Stop accepting new connections
  if (!IS_DEMO_MODE) {
    await BackupManager.backupState(); // Save state
  }

  process.exit(0);
};

// Handle shutdown signals
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
