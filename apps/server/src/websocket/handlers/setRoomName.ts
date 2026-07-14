import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { sendBroadcast } from "@/utils/responses";
import { requireCanMutate } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

/**
 * Set the room's display name. Empty string clears it (UI falls back to
 * "Room <id>"). Gated by requireCanMutate so jam-mode rooms let any visitor
 * rename, matching shape/playlist mutations.
 */
export const handleSetRoomName: HandlerFunction<ExtractWSRequestFrom["SET_ROOM_NAME"]> = ({ ws, message, server }) => {
  const { room } = requireCanMutate(ws);
  room.setRoomName(message.roomName);
  sendBroadcast({
    server,
    roomId: ws.data.roomId,
    message: {
      type: "ROOM_EVENT",
      event: { type: "ROOM_NAME_UPDATE", roomName: room.getRoomName() ?? "" },
    },
  });
};
