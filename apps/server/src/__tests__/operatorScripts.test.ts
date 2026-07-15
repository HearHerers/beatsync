import { describe, expect, it } from "bun:test";
import type { RoomBackupType } from "@/managers/RoomManager";
import { summarizeRoom, trackTitleFromUrl } from "../../scripts/lib/backupSnapshot";

const pausedState = {
  type: "paused" as const,
  audioSource: "",
  trackIndex: 0,
  serverTimeToExecute: 0,
  trackPositionSeconds: 0,
};

const baseRoom: RoomBackupType = {
  clientDatas: [],
  globalVolume: 1,
  lowPassFreq: 20000,
  playlists: [],
};

describe("trackTitleFromUrl", () => {
  it("strips the ☆-timestamp uniquifier from R2 keys", () => {
    expect(trackTitleFromUrl("https://cdn.example.com/room-482913/My%20Song%E2%98%861733600000000.mp3")).toBe(
      "My Song.mp3"
    );
  });

  it("returns the basename unchanged when there is no uniquifier", () => {
    expect(trackTitleFromUrl("https://cdn.example.com/room-1/track.mp3?sig=abc")).toBe("track.mp3");
  });

  it("survives invalid percent-escapes", () => {
    expect(trackTitleFromUrl("room-1/bad%zzname.mp3")).toBe("bad%zzname.mp3");
  });
});

describe("summarizeRoom", () => {
  it("summarizes a map room with zones, playing state, and token presence", () => {
    const room: RoomBackupType = {
      ...baseRoom,
      roomName: "Saturday Set",
      roomType: "map",
      adminToken: "tok",
      chat: { messages: [], nextMessageId: 1 },
      shapes: [
        {
          id: "shape-1",
          type: "polygon",
          coordinates: [],
          createdBy: "c1",
          createdAt: 1,
          groupId: null,
          falloffMeters: 15,
        },
      ],
      playlists: [
        {
          id: "shape-1",
          tracks: [{ url: "a.mp3" }, { url: "b.mp3" }],
          loop: false,
          playbackState: { ...pausedState, type: "playing", audioSource: "a.mp3" },
        },
        { id: "main", tracks: [{ url: "c.mp3" }], loop: false, playbackState: pausedState },
      ],
    };

    expect(summarizeRoom("482913", room)).toEqual({
      roomId: "482913",
      roomName: "Saturday Set",
      roomType: "map",
      zoneCount: 1,
      trackCount: 3,
      isPlaying: true,
      chatMessageCount: 0,
      cachedClientCount: 0,
      hasAdminToken: true,
      archived: false,
    });
  });

  it("defaults an untyped, unnamed room to a non-playing audio room without zones", () => {
    const summary = summarizeRoom("771204", baseRoom);
    expect(summary.roomType).toBe("audio");
    expect(summary.roomName).toBeNull();
    expect(summary.zoneCount).toBeNull();
    expect(summary.isPlaying).toBe(false);
    expect(summary.hasAdminToken).toBe(false);
  });
});
