import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
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
