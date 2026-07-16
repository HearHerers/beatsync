// DELETE_AUDIO_SOURCES must remove the deleted file's URL from EVERY context,
// not just the main queue: a pool track added to zone playlists is the same URL
// referenced from several contexts, so leaving it in a zone after the R2 object
// is gone would leave a dead link. Zones playing the deleted track get a
// contextId-scoped PAUSE.

import type { WSBroadcastType } from "@beatsync/shared";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { createMockServer, createMockWs } from "@/__tests__/mocks/websocket";
import { globalManager } from "@/managers/GlobalManager";
import type { BunServer } from "@/utils/websocket";

let broadcasts: { server: BunServer; roomId: string; message: WSBroadcastType }[] = [];

mockR2();

void mock.module("@/utils/responses", () => ({
  sendBroadcast: mock(
    ({ server, roomId, message }: { server: BunServer; roomId: string; message: WSBroadcastType }) => {
      broadcasts.push({ server, roomId, message });
    }
  ),
  sendUnicast: mock(() => {
    /* noop */
  }),
  sendToClient: mock(() => {
    /* noop */
  }),
  corsHeaders: {},
  jsonResponse: mock(() => new Response()),
  errorResponse: mock(() => new Response()),
}));

import type { ShapeType } from "@beatsync/shared";
import { handleDeleteAudioSources } from "@/websocket/handlers/handleDeleteAudioSources";

const ROOM_ID = "delete-all-contexts-test";

function makeShape(id: string): ShapeType {
  return {
    id,
    type: "polygon",
    coordinates: [
      [
        [42.28, -83.74],
        [42.281, -83.74],
        [42.281, -83.741],
      ],
    ],
    createdBy: "creator",
    createdAt: Date.now(),
    groupId: null,
    falloffMeters: 25,
  };
}

// Map room with a pool track referenced by two zone contexts, one of which is
// currently playing it. "pool.mp3" is a non-R2 URL so the delete handler takes
// the always-succeeds path without touching storage.
function poolRoomWithZones() {
  for (const id of globalManager.getRoomIds()) globalManager.deleteRoom(id);
  const room = globalManager.getOrCreateRoom(ROOM_ID);
  room.setRoomType("map");
  const adminWs = createMockWs({ clientId: "admin-1", roomId: ROOM_ID });
  room.addClient(adminWs);

  room.addAudioSource({ url: "pool.mp3" });
  room.addAudioSource({ url: "other.mp3" });
  room.addShape(makeShape("zone-a")); // creates playlist context "zone-a"
  room.addShape(makeShape("zone-b"));
  room.addTrackToContext("zone-a", { url: "pool.mp3" });
  room.addTrackToContext("zone-b", { url: "pool.mp3" });
  room.addTrackToContext("zone-b", { url: "other.mp3" });
  room.updatePlaybackSchedulePlay(
    { type: "PLAY", audioSource: "pool.mp3", trackTimeSeconds: 0, contextId: "zone-a" },
    Date.now()
  );

  return { room, adminWs, server: createMockServer() };
}

beforeEach(() => {
  broadcasts = [];
});

describe("handleDeleteAudioSources across contexts", () => {
  it("strips the URL from main and every zone context", async () => {
    const { room, adminWs, server } = poolRoomWithZones();
    await handleDeleteAudioSources({
      ws: adminWs,
      message: { type: "DELETE_AUDIO_SOURCES", urls: ["pool.mp3"] },
      server,
    });

    expect(room.getAudioSources().map((s) => s.url)).toEqual(["other.mp3"]);
    expect(room.getPlaylist("zone-a")?.tracks).toEqual([]);
    expect(room.getPlaylist("zone-b")?.tracks).toEqual([{ url: "other.mp3" }]);

    // The final playlists broadcast reflects all three contexts.
    const playlistUpdates = broadcasts.filter(
      (b) => b.message.type === "ROOM_EVENT" && b.message.event.type === "PLAYLISTS_UPDATE"
    );
    const last = playlistUpdates.at(-1)?.message;
    if (last?.type !== "ROOM_EVENT" || last.event.type !== "PLAYLISTS_UPDATE") {
      throw new Error("expected a PLAYLISTS_UPDATE broadcast");
    }
    for (const playlist of last.event.playlists) {
      expect(playlist.tracks.some((t) => t.url === "pool.mp3")).toBe(false);
    }
  });

  it("schedules a contextId-scoped PAUSE for the zone playing the deleted track", async () => {
    const { adminWs, server } = poolRoomWithZones();
    await handleDeleteAudioSources({
      ws: adminWs,
      message: { type: "DELETE_AUDIO_SOURCES", urls: ["pool.mp3"] },
      server,
    });

    const pauses = broadcasts.filter((b) => b.message.type === "SCHEDULED_ACTION");
    const zonePauses = pauses.filter(
      (b) =>
        b.message.type === "SCHEDULED_ACTION" &&
        b.message.scheduledAction.type === "PAUSE" &&
        "contextId" in b.message.scheduledAction &&
        b.message.scheduledAction.contextId === "zone-a"
    );
    expect(zonePauses).toHaveLength(1);
    // zone-b references the track but isn't playing it — no pause for it.
    const zoneBPause = pauses.some(
      (b) =>
        b.message.type === "SCHEDULED_ACTION" &&
        "contextId" in b.message.scheduledAction &&
        b.message.scheduledAction.contextId === "zone-b"
    );
    expect(zoneBPause).toBe(false);
  });

  it("deleting a track no zone is playing schedules no pause at all", async () => {
    const { adminWs, server } = poolRoomWithZones();
    await handleDeleteAudioSources({
      ws: adminWs,
      message: { type: "DELETE_AUDIO_SOURCES", urls: ["other.mp3"] },
      server,
    });
    expect(broadcasts.some((b) => b.message.type === "SCHEDULED_ACTION")).toBe(false);
  });
});
