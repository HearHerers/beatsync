import { ADMIN_SECRET, IS_DEMO_MODE } from "@/demo";
import { validateR2Config } from "@/lib/r2";
import { BackupManager } from "@/managers/BackupManager";
import { getActiveRooms } from "@/routes/active";
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
if (r2Valid) {
  try {
    await BackupManager.restoreState();
  } catch (error) {
    console.error("Failed to restore state on startup:", error);
  }
} else if (!IS_DEMO_MODE) {
  console.log("ℹ️  R2 not configured; skipping state restore (state will not persist).");
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

if (r2Valid) {
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
