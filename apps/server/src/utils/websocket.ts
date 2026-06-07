import type { RoomTypeValue } from "@beatsync/shared";
import type { Server } from "bun";

export interface WSData {
  roomId: string;
  clientId: string;
  username: string;
  isAdmin: boolean;
  isCreator: boolean;
  // Per-room admin token presented by the client (from localStorage). Matches
  // against the room's stored token to grant admin — the recoverable curator
  // credential. See RoomManager.addClient.
  roomAdminToken?: string;
  // Requested room type from the WS upgrade query string. The first client to connect to
  // a room determines its type; subsequent clients with a different requested type get
  // the room's existing type instead.
  requestedRoomType?: RoomTypeValue;
}

export type BunServer = Server<WSData>;
