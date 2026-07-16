// Tests all-zone playback (PLAY_ALL_CONTEXTS / PAUSE_ALL_CONTEXTS): which
// contexts the batch targets, and — the whole point — that a batched play
// phase-locks every context to ONE shared serverTimeToExecute.

import type { ShapeType, WSBroadcastType } from "@beatsync/shared";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { createMockServer } from "@/__tests__/mocks/websocket";
import { RoomManager } from "@/managers/RoomManager";
import type { BunServer } from "@/utils/websocket";

let broadcasts: { message: WSBroadcastType }[] = [];

mockR2();

void mock.module("@/utils/responses", () => ({
  sendBroadcast: mock(({ message }: { message: WSBroadcastType }) => {
    broadcasts.push({ message });
  }),
  sendUnicast: mock(() => {
    /* noop */
  }),
  corsHeaders: {},
  jsonResponse: mock(() => new Response()),
  errorResponse: mock(() => new Response()),
}));

const ROOM_ID = "all-zone-test";

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
    createdAt: 1,
    groupId: null,
    falloffMeters: 25,
  };
}

/** Map room with two zones, each holding one track. */
function mapRoomWithTwoZones(): RoomManager {
  const room = new RoomManager(ROOM_ID);
  room.setRoomType("map");
  room.addShape(makeShape("s1"));
  room.addShape(makeShape("s2"));
  room.addTrackToContext("s1", { url: "https://x/a.mp3" });
  room.addTrackToContext("s2", { url: "https://x/b.mp3" });
  return room;
}

function scheduledPlays() {
  return broadcasts
    .map((b) => b.message)
    .filter((m): m is Extract<WSBroadcastType, { type: "SCHEDULED_ACTION" }> => m.type === "SCHEDULED_ACTION")
    .filter((m) => m.scheduledAction.type === "PLAY");
}

describe("all-zone playback", () => {
  let server: BunServer;

  beforeEach(() => {
    broadcasts = [];
    server = createMockServer();
  });

  afterEach(() => {
    /* nothing persistent to clean up (rooms are local to each test) */
  });

  describe("buildPlayAllActions", () => {
    it("targets zones only — excludes the Room Pool (main) in map rooms", () => {
      const room = mapRoomWithTwoZones();
      // Sanity: the pool-superset invariant put both tracks in main too.
      expect(room.getPlaylist(MAIN_CONTEXT_ID)?.tracks.length).toBe(2);

      const actions = room.buildPlayAllActions();
      const ctxIds = actions.map((a) => a.contextId).sort();
      expect(ctxIds).toEqual(["s1", "s2"]);
      expect(actions.every((a) => a.contextId !== MAIN_CONTEXT_ID)).toBe(true);
    });

    it("plays the main context in an audio room (its only context, no contextId)", () => {
      const room = new RoomManager(ROOM_ID);
      room.addAudioSource({ url: "https://x/a.mp3" });

      const actions = room.buildPlayAllActions();
      expect(actions).toHaveLength(1);
      expect(actions[0].contextId).toBeUndefined();
    });

    it("skips empty zones and honors a contextIds filter", () => {
      const room = mapRoomWithTwoZones();
      room.addShape(makeShape("s3")); // no tracks

      expect(
        room
          .buildPlayAllActions()
          .map((a) => a.contextId)
          .sort()
      ).toEqual(["s1", "s2"]);
      expect(room.buildPlayAllActions(["s1"]).map((a) => a.contextId)).toEqual(["s1"]);
    });
  });

  describe("initiateBatchedPlay", () => {
    it("phase-locks every zone to one shared serverTimeToExecute", () => {
      const room = mapRoomWithTwoZones();
      // No connected clients → flushes immediately (no load-ack wait).
      room.initiateBatchedPlay(room.buildPlayAllActions(), "initiator", server);

      const plays = scheduledPlays();
      expect(plays).toHaveLength(2);
      const times = new Set(plays.map((p) => p.serverTimeToExecute));
      expect(times.size).toBe(1); // all zones start at the same instant
    });

    it("after playing, buildPauseAllActions returns exactly the playing zones", () => {
      const room = mapRoomWithTwoZones();
      expect(room.buildPauseAllActions()).toHaveLength(0);

      room.initiateBatchedPlay(room.buildPlayAllActions(), "initiator", server);

      const pauses = room.buildPauseAllActions();
      expect(pauses.map((a) => a.contextId).sort()).toEqual(["s1", "s2"]);
    });
  });
});
