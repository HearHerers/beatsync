import type { AudioSourceType, ExtractWSRequestFrom } from "@beatsync/shared";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
import { copyObjectIntoRoom, isOwnBucketUrl, roomIdFromUrl } from "@/lib/r2";
import { sendBroadcast } from "@/utils/responses";
import { requireCanMutate } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

/**
 * ADD_TRACK_TO_CONTEXT: admin appends a track to a specific playlist context.
 * Broadcasts PLAYLISTS_UPDATE so every client mirrors the new track set.
 */
export const handleAddTrackToContext: HandlerFunction<ExtractWSRequestFrom["ADD_TRACK_TO_CONTEXT"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const contextId = message.contextId ?? MAIN_CONTEXT_ID;
  const tracks = room.addTrackToContext(contextId, message.source);
  if (!tracks) {
    console.warn(`ADD_TRACK_TO_CONTEXT for unknown context ${contextId} in ${room.getRoomId()}`);
    return;
  }
  sendBroadcast({
    server,
    roomId: room.getRoomId(),
    message: {
      type: "ROOM_EVENT",
      event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
    },
  });
};

/**
 * REMOVE_TRACK_FROM_CONTEXT: admin removes a track. If the removed track was
 * currently playing, the server's removeTrackFromContext also resets the
 * playlist's playback to paused — the broadcast snapshot reflects both.
 */
export const handleRemoveTrackFromContext: HandlerFunction<ExtractWSRequestFrom["REMOVE_TRACK_FROM_CONTEXT"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const contextId = message.contextId ?? MAIN_CONTEXT_ID;
  const result = room.removeTrackFromContext(contextId, message.url);
  if (!result) return;
  sendBroadcast({
    server,
    roomId: room.getRoomId(),
    message: {
      type: "ROOM_EVENT",
      event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
    },
  });
};

/**
 * REORDER_TRACK_IN_CONTEXT: admin reorders the tracks within a context's
 * playlist. On a stale order (a concurrent add/remove made it no longer a
 * permutation) the reorder is rejected but we still broadcast the authoritative
 * snapshot so the optimistic client resyncs to truth rather than diverging.
 */
export const handleReorderTrackInContext: HandlerFunction<ExtractWSRequestFrom["REORDER_TRACK_IN_CONTEXT"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const contextId = message.contextId ?? MAIN_CONTEXT_ID;
  const result = room.reorderTrackInContext(contextId, message.orderedUrls);
  // Unknown context: nothing to broadcast (e.g. stale message for a deleted shape).
  if (result === undefined) return;
  if (result instanceof Error) {
    console.warn(`REORDER_TRACK_IN_CONTEXT rejected: ${result.message}`);
    // Fall through to broadcast so the client resyncs to the authoritative order.
  }

  // Mirror the per-context change to clients via the playlists channel.
  sendBroadcast({
    server,
    roomId: room.getRoomId(),
    message: {
      type: "ROOM_EVENT",
      event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
    },
  });
  // For the main context, also emit the legacy SET_AUDIO_SOURCES room event so
  // audio-room UI listening on that channel stays in sync.
  if (contextId === MAIN_CONTEXT_ID) {
    sendBroadcast({
      server,
      roomId: room.getRoomId(),
      message: {
        type: "ROOM_EVENT",
        event: { type: "SET_AUDIO_SOURCES", sources: room.getAudioSources() },
      },
    });
  }
};

/**
 * IMPORT_TRACKS_TO_CONTEXT: bulk-add tracks from an imported playlist file.
 * Each URL is resolved to a track that lives in THIS room before adding:
 *   - already in this room's prefix → referenced as-is;
 *   - in our bucket but another room's prefix → server-side copied into this
 *     room (self-contained, survives the source room's deletion);
 *   - foreign host (exported from another deployment) → referenced as-is, since
 *     we can neither copy nor safely fetch it.
 * Copy failures (e.g. a deleted source object) skip that track; the rest import.
 */
export const handleImportTracksToContext: HandlerFunction<ExtractWSRequestFrom["IMPORT_TRACKS_TO_CONTEXT"]> = async ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const roomId = room.getRoomId();
  const contextId = message.contextId ?? MAIN_CONTEXT_ID;

  // Guard the context up front so we don't copy objects for a missing playlist.
  if (!room.getPlaylist(contextId)) {
    console.warn(`IMPORT_TRACKS_TO_CONTEXT for unknown context ${contextId} in ${roomId}`);
    return;
  }

  // De-duplicate the incoming list by source URL so a file listing the same
  // track twice only copies/adds it once.
  const uniqueUrls = Array.from(new Set(message.urls));

  const resolved: AudioSourceType[] = [];
  let copied = 0;
  let referencedForeign = 0;
  let skipped = 0;
  for (const url of uniqueUrls) {
    if (roomIdFromUrl(url) === roomId) {
      resolved.push({ url }); // already ours — reference
    } else if (isOwnBucketUrl(url)) {
      const copiedUrl = await copyObjectIntoRoom(url, roomId);
      if (copiedUrl) {
        resolved.push({ url: copiedUrl });
        copied++;
      } else {
        skipped++; // source object gone / copy failed
      }
    } else {
      resolved.push({ url }); // foreign deployment — reference, can't self-host
      referencedForeign++;
    }
  }

  if (resolved.length === 0) {
    console.warn(`IMPORT_TRACKS_TO_CONTEXT into ${roomId}/${contextId}: nothing importable (${skipped} skipped)`);
    return;
  }

  room.addTracksToContext(contextId, resolved);
  console.log(
    `IMPORT_TRACKS_TO_CONTEXT into ${roomId}/${contextId}: ${resolved.length} added ` +
      `(${copied} copied, ${referencedForeign} foreign-referenced, ${skipped} skipped)`
  );

  sendBroadcast({
    server,
    roomId,
    message: {
      type: "ROOM_EVENT",
      event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
    },
  });
};
