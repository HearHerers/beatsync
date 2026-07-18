import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { sendBroadcast } from "@/utils/responses";
import { requireRoom } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

export const handleAudioSourceLoaded: HandlerFunction<ExtractWSRequestFrom["AUDIO_SOURCE_LOADED"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireRoom(ws);

  // Process that this client has loaded the audio source. Routes to the right
  // context's load gate; omitted contextId defaults to "main" (audio rooms).
  room.processClientLoadedAudioSource(ws.data.clientId, server, message.contextId);

  // The decoded duration is the ground truth for beatgrid matching: stamp it
  // on the track and reconcile against the beatgrid index — a late-learned
  // duration can attach a grid (duration+loose-title fallback), correct one,
  // or detach a wrong-version name match. Idempotent across the many clients
  // reporting the same load, so the broadcast only fires when state changed.
  const durationSec = message.source.durationSec;
  if (durationSec !== undefined) {
    const changed = room.setTrackDuration(message.source.url, durationSec);
    if (changed > 0) {
      sendBroadcast({
        server,
        roomId: room.getRoomId(),
        message: {
          type: "ROOM_EVENT",
          event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
        },
      });
    }
  }
};
