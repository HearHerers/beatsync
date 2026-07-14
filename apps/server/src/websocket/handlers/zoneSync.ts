// Handlers for zone beat-matching: beatgrid attachment + the SYNC_ZONES action.
// The math lives in @/lib/zoneSync; the authoritative state update lives in
// RoomManager. These handlers validate, delegate, and broadcast.

import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
import { sendBroadcast } from "@/utils/responses";
import { requireCanMutate } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

/**
 * SET_TRACK_BEATGRID: attach imported beatgrid data to a track URL. Applies to
 * every context containing the URL; clients mirror it via PLAYLISTS_UPDATE.
 */
export const handleSetTrackBeatgrid: HandlerFunction<ExtractWSRequestFrom["SET_TRACK_BEATGRID"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const updated = room.setTrackBeatgrid(message.url, message.beatgrid);
  if (updated === 0) {
    console.warn(`SET_TRACK_BEATGRID: URL not in room ${room.getRoomId()}: ${message.url}`);
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
 * SYNC_ZONES: beat-match the follower zone to the master zone. On success the
 * follower's rescheduled PLAY (with playbackRate) is broadcast as a normal
 * SCHEDULED_ACTION — no load gate needed, the follower's track is already
 * decoded everywhere because it's playing. The master is never interrupted.
 */
export const handleSyncZones: HandlerFunction<ExtractWSRequestFrom["SYNC_ZONES"]> = ({ ws, message, server }) => {
  const { room } = requireCanMutate(ws);
  const result = room.syncZones(message.masterContextId, message.followerContextId);
  if (result instanceof Error) {
    console.warn(
      `SYNC_ZONES rejected in ${room.getRoomId()} (${message.followerContextId} → ${message.masterContextId}): ${result.message}`
    );
    return;
  }
  sendBroadcast({
    server,
    roomId: room.getRoomId(),
    message: {
      type: "SCHEDULED_ACTION",
      scheduledAction: {
        type: "PLAY",
        audioSource: result.audioSource,
        trackTimeSeconds: result.followerTrackTimeSeconds,
        playbackRate: result.followerRate,
        ...(message.followerContextId !== MAIN_CONTEXT_ID && { contextId: message.followerContextId }),
      },
      serverTimeToExecute: result.anchorServerTime,
    },
  });
  // Mirror the new rate/position into every client's playlist view (sync badge UI).
  sendBroadcast({
    server,
    roomId: room.getRoomId(),
    message: {
      type: "ROOM_EVENT",
      event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
    },
  });
};
