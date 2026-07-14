import type { ExtractWSRequestFrom } from "@beatsync/shared";
import { IS_DEMO_MODE } from "@/demo";
import { requireCanMutate } from "@/websocket/middlewares";
import type { HandlerFunction } from "@/websocket/types";

export const handlePlayAllContexts: HandlerFunction<ExtractWSRequestFrom["PLAY_ALL_CONTEXTS"]> = ({
  ws,
  message,
  server,
}) => {
  const { room } = requireCanMutate(ws);
  const playActions = room.buildPlayAllActions(message.contextIds, { resume: message.resume });
  if (playActions.length === 0) {
    console.log(`Room ${ws.data.roomId}: PLAY_ALL_CONTEXTS — no eligible contexts`);
    return;
  }

  if (IS_DEMO_MODE) {
    // Demo: skip load coordination; clients are pre-cached. Reuse the same
    // shared-timestamp emission path that the batch flush uses.
    room.broadcastBatchedPlayImmediate(playActions, server);
    return;
  }

  room.initiateBatchedPlay(playActions, ws.data.clientId, server);
};
