import { IS_DEMO_MODE } from "@/demo";
import { deleteObject, keyFromPublicUrl } from "@/lib/r2";
import type { RoomManager } from "@/managers/RoomManager";
import { sendBroadcast } from "@/utils/responses";
import { requireCanMutate } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";
import type { BunServer } from "@/utils/websocket";
import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";

/**
 * Deleting the playing track resets the room's playback state to paused, but
 * that alone doesn't stop audio already running on clients — schedule an
 * explicit pause for everyone. Scoped to `contextId` when given (a zone
 * playlist); omitted, it targets the main-context/audio-room channel.
 */
const broadcastPauseForRemovedCurrent = (server: BunServer, roomId: string, room: RoomManager, contextId?: string) => {
  sendBroadcast({
    server,
    roomId,
    message: {
      type: "SCHEDULED_ACTION",
      scheduledAction: {
        type: "PAUSE",
        audioSource: "",
        trackTimeSeconds: 0,
        ...(contextId !== undefined && { contextId }),
      },
      serverTimeToExecute: room.getScheduledExecutionTime(),
    },
  });
};

/**
 * A pool track added to zone playlists is the SAME URL referenced from several
 * contexts, so deleting the file must also strip the URL from every zone
 * context — otherwise those playlists keep dead links to the deleted object.
 * (Main is handled separately by removeAudioSources.) Returns the ids of
 * contexts whose currently-playing track was removed and thus need a pause.
 */
const removeFromZoneContexts = (room: RoomManager, urls: string[]): string[] => {
  const pausedContexts: string[] = [];
  for (const contextId of room.getPlaylistIds()) {
    if (contextId === MAIN_CONTEXT_ID) continue;
    let removedCurrent = false;
    for (const url of urls) {
      const result = room.removeTrackFromContext(contextId, url);
      if (result?.removedCurrent) removedCurrent = true;
    }
    if (removedCurrent) pausedContexts.push(contextId);
  }
  return pausedContexts;
};

export const handleDeleteAudioSources: HandlerFunction<ExtractWSRequestFrom["DELETE_AUDIO_SOURCES"]> = async ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);

  // Get current URLs to validate the request
  const currentUrls = new Set(room.getAudioSources().map((s) => s.url));

  // Only process URLs that actually exist in the room
  const urlsToDelete = message.urls.filter((url) => currentUrls.has(url));

  if (urlsToDelete.length === 0) {
    return; // nothing to do, silent idempotency
  }

  // In demo mode, skip R2 deletion — just remove from room state
  if (IS_DEMO_MODE) {
    const { updated, removedCurrent } = room.removeAudioSources(urlsToDelete);
    if (removedCurrent) {
      broadcastPauseForRemovedCurrent(server, ws.data.roomId, room);
    }
    for (const contextId of removeFromZoneContexts(room, urlsToDelete)) {
      broadcastPauseForRemovedCurrent(server, ws.data.roomId, room, contextId);
    }
    sendBroadcast({
      server,
      roomId: ws.data.roomId,
      message: {
        type: "ROOM_EVENT",
        event: { type: "SET_AUDIO_SOURCES", sources: updated },
      },
    });
    sendBroadcast({
      server,
      roomId: ws.data.roomId,
      message: {
        type: "ROOM_EVENT",
        event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
      },
    });
    return;
  }

  // First, attempt to delete room-specific files from R2 storage
  // Track which URLs were successfully deleted from R2
  const successfullyDeletedUrls = new Set<string>();
  const roomPrefix = `/room-${ws.data.roomId}/`;

  // Process R2 deletions and track successes
  const r2DeletionPromises = urlsToDelete.map(async (url) => {
    // Always add non-R2 URLs (like default tracks) to successful list
    if (!url.includes(roomPrefix)) {
      successfullyDeletedUrls.add(url); // Just say we've processed it
      return;
    }

    // Otherwise we need to actually delete the file from R2. Key derivation
    // must be bucket-aware (keyFromPublicUrl, not the raw URL pathname):
    // path-style PUBLIC_URLs fold the bucket into the path, and DeleteObject
    // on a wrong key "succeeds" silently, orphaning the object.
    try {
      const key = keyFromPublicUrl(url);

      if (!key) {
        throw new Error(`Failed to extract key from URL: ${url}`);
      }

      await deleteObject(key);
      console.log(`🗑️ Deleted R2 object: ${key}`);
      successfullyDeletedUrls.add(url);
    } catch (error) {
      console.error(`Failed to delete R2 object for URL ${url}:`, error);
      // Don't add to successfullyDeletedUrls - keep in room state
    }
  });

  // Wait for all R2 deletion attempts to complete
  await Promise.all(r2DeletionPromises);

  // Only remove successfully deleted URLs from the room's queue
  const urlsToRemove = Array.from(successfullyDeletedUrls);

  if (urlsToRemove.length === 0) {
    console.log("No URLs were successfully deleted from R2, keeping all in queue");
    return;
  }

  // Remove only the successfully deleted sources from room state
  const { updated, removedCurrent } = room.removeAudioSources(urlsToRemove);

  if (removedCurrent) {
    broadcastPauseForRemovedCurrent(server, ws.data.roomId, room);
  }
  for (const contextId of removeFromZoneContexts(room, urlsToRemove)) {
    broadcastPauseForRemovedCurrent(server, ws.data.roomId, room, contextId);
  }

  // Broadcast updated queue to all clients
  sendBroadcast({
    server,
    roomId: ws.data.roomId,
    message: {
      type: "ROOM_EVENT",
      event: { type: "SET_AUDIO_SOURCES", sources: updated },
    },
  });
  sendBroadcast({
    server,
    roomId: ws.data.roomId,
    message: {
      type: "ROOM_EVENT",
      event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
    },
  });
};
