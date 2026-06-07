import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { sendBroadcast } from "@/utils/responses";
import { requireRoom } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

/**
 * Update the caller's display name. Anyone can rename themselves (no admin
 * gate — it's their own identity, not a room mutation). Broadcasts the
 * updated client list so every other connected client sees the change.
 */
export const handleSetUsername: HandlerFunction<ExtractWSRequestFrom["SET_USERNAME"]> = ({ ws, message, server }) => {
  const { room } = requireRoom(ws);
  const changed = room.setClientUsername(ws.data.clientId, message.username);
  if (!changed) return;
  // Keep ws.data.username in sync so subsequent open/close/log lines reflect
  // the new name without needing a reconnect.
  ws.data.username = room.getClient(ws.data.clientId)?.username ?? ws.data.username;
  sendBroadcast({
    server,
    roomId: ws.data.roomId,
    message: {
      type: "ROOM_EVENT",
      event: { type: "CLIENT_CHANGE", clients: room.getClients() },
    },
  });
};
