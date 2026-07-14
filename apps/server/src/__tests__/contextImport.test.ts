// Tests for handleImportTracksToContext: the URL-classification + bulk-add flow
// used by playlist import. The R2 module is mocked so each URL's fate (reference
// vs. copy vs. skip) is deterministic and no network/S3 is touched.

import type { WSBroadcastType } from "@beatsync/shared";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { createMockServer, createMockWs } from "@/__tests__/mocks/websocket";
import type { BunServer } from "@/utils/websocket";

let broadcasts: { server: BunServer; roomId: string; message: WSBroadcastType }[] = [];

const ROOM_ID = "import-test";
const COPY_HOST = "https://cdn.test";

// Deterministic stand-ins for the real R2 classification helpers:
//  - roomIdFromUrl: parse `room-X/` out of a COPY_HOST URL's path.
//  - isOwnBucketUrl: true only for COPY_HOST.
//  - copyObjectIntoRoom: returns a rewritten dest URL, or null for "missing".
mockR2({
  roomIdFromUrl: mock((url: string) => {
    if (!url.startsWith(COPY_HOST)) return null;
    const m = /\/room-([^/]+)\//.exec(url);
    return m ? m[1] : null;
  }),
  isOwnBucketUrl: mock((url: string) => url.startsWith(COPY_HOST)),
  copyObjectIntoRoom: mock((url: string, destRoomId: string) =>
    Promise.resolve(url.includes("missing") ? null : `${COPY_HOST}/room-${destRoomId}/copied-${url.split("/").pop()}`)
  ),
});

void mock.module("@/utils/responses", () => ({
  sendBroadcast: mock(
    ({ server, roomId, message }: { server: BunServer; roomId: string; message: WSBroadcastType }) => {
      broadcasts.push({ server, roomId, message });
    }
  ),
  sendUnicast: mock(() => {
    /* noop */
  }),
  corsHeaders: {},
  jsonResponse: mock(() => new Response()),
  errorResponse: mock(() => new Response()),
}));

import { globalManager } from "@/managers/GlobalManager";
import { handleImportTracksToContext } from "@/websocket/handlers/contextTracks";

function freshMapRoomWithShape(shapeId: string) {
  for (const id of globalManager.getRoomIds()) globalManager.deleteRoom(id);
  const room = globalManager.getOrCreateRoom(ROOM_ID);
  room.setRoomType("map");
  const adminWs = createMockWs({ clientId: "admin-1", roomId: ROOM_ID }); // first connection → admin
  room.addClient(adminWs);
  room.addPlaylist(shapeId, { loop: true });
  return { room, adminWs, server: createMockServer() };
}

function importedTracks(shapeId: string): string[] {
  const found = [...broadcasts]
    .reverse()
    .find((b) => b.message.type === "ROOM_EVENT" && b.message.event.type === "PLAYLISTS_UPDATE");
  if (!found) throw new Error("expected a PLAYLISTS_UPDATE broadcast");
  const ev = found.message as Extract<WSBroadcastType, { type: "ROOM_EVENT" }>;
  if (ev.event.type !== "PLAYLISTS_UPDATE") throw new Error("unreachable");
  return ev.event.playlists.find((p) => p.id === shapeId)?.tracks.map((t) => t.url) ?? [];
}

beforeEach(() => {
  broadcasts = [];
});

describe("handleImportTracksToContext", () => {
  it("references same-room URLs, copies foreign same-bucket URLs, skips missing, references foreign hosts", async () => {
    const { adminWs, server } = freshMapRoomWithShape("s1");

    await handleImportTracksToContext({
      ws: adminWs,
      message: {
        type: "IMPORT_TRACKS_TO_CONTEXT",
        contextId: "s1",
        urls: [
          `${COPY_HOST}/room-${ROOM_ID}/a.mp3`, // already ours → referenced as-is
          `${COPY_HOST}/room-OTHER/b.mp3`, // foreign room, our bucket → copied
          `${COPY_HOST}/room-OTHER/missing.mp3`, // copy fails → skipped
          "https://elsewhere.example/x.mp3", // foreign host → referenced as-is
        ],
      },
      server,
    });

    expect(importedTracks("s1")).toEqual([
      `${COPY_HOST}/room-${ROOM_ID}/a.mp3`,
      `${COPY_HOST}/room-${ROOM_ID}/copied-b.mp3`,
      "https://elsewhere.example/x.mp3",
    ]);
  });

  it("de-duplicates the incoming URL list", async () => {
    const { adminWs, server } = freshMapRoomWithShape("s1");

    await handleImportTracksToContext({
      ws: adminWs,
      message: {
        type: "IMPORT_TRACKS_TO_CONTEXT",
        contextId: "s1",
        urls: [`${COPY_HOST}/room-${ROOM_ID}/a.mp3`, `${COPY_HOST}/room-${ROOM_ID}/a.mp3`],
      },
      server,
    });

    expect(importedTracks("s1")).toEqual([`${COPY_HOST}/room-${ROOM_ID}/a.mp3`]);
  });

  it("does not change the destination zone's loop flag", async () => {
    const { room, adminWs, server } = freshMapRoomWithShape("s1");
    expect(room.getPlaylist("s1")?.loop).toBe(true);

    await handleImportTracksToContext({
      ws: adminWs,
      message: {
        type: "IMPORT_TRACKS_TO_CONTEXT",
        contextId: "s1",
        urls: [`${COPY_HOST}/room-${ROOM_ID}/a.mp3`],
      },
      server,
    });

    expect(room.getPlaylist("s1")?.loop).toBe(true);
  });

  it("ignores an unknown context (no broadcast)", async () => {
    const { adminWs, server } = freshMapRoomWithShape("s1");
    broadcasts = [];

    await handleImportTracksToContext({
      ws: adminWs,
      message: {
        type: "IMPORT_TRACKS_TO_CONTEXT",
        contextId: "ghost",
        urls: [`${COPY_HOST}/room-${ROOM_ID}/a.mp3`],
      },
      server,
    });

    expect(broadcasts).toHaveLength(0);
  });

  it("does not broadcast when every track is skipped", async () => {
    const { adminWs, server } = freshMapRoomWithShape("s1");
    broadcasts = [];

    await handleImportTracksToContext({
      ws: adminWs,
      message: {
        type: "IMPORT_TRACKS_TO_CONTEXT",
        contextId: "s1",
        urls: [`${COPY_HOST}/room-OTHER/missing.mp3`],
      },
      server,
    });

    expect(broadcasts).toHaveLength(0);
  });
});
