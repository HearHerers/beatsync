// Tests for the room-name feature: SET_ROOM_NAME action, ROOM_NAME_UPDATE
// broadcast, getRoomName / setRoomName on RoomManager, and round-trip through
// the backup format.

import type { WSBroadcastType } from "@beatsync/shared";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { createMockServer, createMockWs } from "@/__tests__/mocks/websocket";
import { globalManager } from "@/managers/GlobalManager";
import { RoomManager } from "@/managers/RoomManager";
import { handleSetRoomName } from "@/websocket/handlers/setRoomName";
import type { BunServer } from "@/utils/websocket";

let broadcasts: { server: BunServer; roomId: string; message: WSBroadcastType }[] = [];

mockR2();

void mock.module("@/utils/responses", () => ({
  sendBroadcast: mock(
    ({ server, roomId, message }: { server: BunServer; roomId: string; message: WSBroadcastType }) => {
      broadcasts.push({ server, roomId, message });
    }
  ),
  sendToClient: mock(() => {
    /* noop */
  }),
  sendUnicast: mock(() => {
    /* noop */
  }),
  corsHeaders: {},
  jsonResponse: mock(() => new Response()),
  errorResponse: mock(() => new Response()),
}));

const ROOM_ID = "rn-test";

function freshRoom() {
  for (const id of globalManager.getRoomIds()) globalManager.deleteRoom(id);
  broadcasts = [];
  const room = globalManager.getOrCreateRoom(ROOM_ID);
  const adminWs = createMockWs({ clientId: "admin", roomId: ROOM_ID });
  room.addClient(adminWs);
  // First-in-room is auto-admin (see RoomManager.addClient).
  return { room, adminWs, server: createMockServer() };
}

beforeEach(() => {
  for (const id of globalManager.getRoomIds()) globalManager.deleteRoom(id);
  broadcasts = [];
});

describe("RoomManager: room name", () => {
  it("defaults to undefined", () => {
    const room = new RoomManager(ROOM_ID);
    expect(room.getRoomName()).toBeUndefined();
  });

  it("setRoomName trims and stores the value", () => {
    const room = new RoomManager(ROOM_ID);
    room.setRoomName("  Cy's Party  ");
    expect(room.getRoomName()).toBe("Cy's Party");
  });

  it("setRoomName with empty string clears the name", () => {
    const room = new RoomManager(ROOM_ID);
    room.setRoomName("test");
    room.setRoomName("");
    expect(room.getRoomName()).toBeUndefined();
  });

  it("setRoomName truncates names longer than 80 chars", () => {
    const room = new RoomManager(ROOM_ID);
    room.setRoomName("x".repeat(200));
    expect(room.getRoomName()?.length).toBe(80);
  });
});

describe("handleSetRoomName", () => {
  it("sets the name and broadcasts ROOM_NAME_UPDATE", () => {
    const { room, adminWs, server } = freshRoom();
    void handleSetRoomName({
      ws: adminWs,
      message: { type: "SET_ROOM_NAME", roomName: "Cy's Party" },
      server,
    });
    expect(room.getRoomName()).toBe("Cy's Party");
    const ev = broadcasts.find(
      (b) => b.message.type === "ROOM_EVENT" && b.message.event.type === "ROOM_NAME_UPDATE"
    )?.message;
    if (ev?.type !== "ROOM_EVENT" || ev.event.type !== "ROOM_NAME_UPDATE") {
      throw new Error("expected ROOM_NAME_UPDATE broadcast");
    }
    expect(ev.event.roomName).toBe("Cy's Party");
  });

  it("clears the name when given an empty string", () => {
    const { room, adminWs, server } = freshRoom();
    room.setRoomName("Pre-existing");
    broadcasts = [];
    void handleSetRoomName({ ws: adminWs, message: { type: "SET_ROOM_NAME", roomName: "" }, server });
    expect(room.getRoomName()).toBeUndefined();
    const ev = broadcasts.find(
      (b) => b.message.type === "ROOM_EVENT" && b.message.event.type === "ROOM_NAME_UPDATE"
    )?.message;
    if (ev?.type !== "ROOM_EVENT" || ev.event.type !== "ROOM_NAME_UPDATE") {
      throw new Error("expected ROOM_NAME_UPDATE broadcast");
    }
    expect(ev.event.roomName).toBe("");
  });
});

describe("RoomManager backup round-trip", () => {
  it("createBackup includes roomName when set", () => {
    const room = new RoomManager(ROOM_ID);
    room.setRoomName("Cy's Party");
    expect(room.createBackup().roomName).toBe("Cy's Party");
  });

  it("createBackup omits roomName when unset", () => {
    const room = new RoomManager(ROOM_ID);
    expect(room.createBackup().roomName).toBeUndefined();
  });
});
