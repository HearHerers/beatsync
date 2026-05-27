import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { requireCanMutate } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

export const handlePauseAllContexts: HandlerFunction<ExtractWSRequestFrom["PAUSE_ALL_CONTEXTS"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const pauseActions = room.buildPauseAllActions(message.contextIds);
  if (pauseActions.length === 0) {
    console.log(`Room ${ws.data.roomId}: PAUSE_ALL_CONTEXTS — no currently-playing contexts`);
    return;
  }
  room.broadcastPauseAll(pauseActions, server);
};
