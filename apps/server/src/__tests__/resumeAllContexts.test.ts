// Tests for pause-all position capture + resume-all (PLAY_ALL_CONTEXTS{resume}).
// The invariant under test: PAUSE_ALL freezes every zone's position at ONE
// shared instant (rate-aware), and resume restarts those positions at ONE
// shared instant with rates preserved — so relative phase between zones,
// including a beat-sync lock, survives the pause/resume cycle.

import { epochNow } from "@beatsync/shared";
import { describe, expect, it } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { RoomManager } from "@/managers/RoomManager";
import type { BunServer } from "@/utils/websocket";

mockR2();

const URL_A = "https://example.com/heat3.flac";
const URL_B = "https://example.com/bump.flac";
const SYNC_RATE = 123.0 / 132.4; // Bump Talkin beat-matched to Heat 3

const stubServer = {
  publish: () => {
    /* broadcast sink — these tests assert on RoomManager state, not messages */
  },
} as unknown as BunServer;

function createRoom(): RoomManager {
  const room = new RoomManager("resume-all-room");
  room.addPlaylist("zoneA", { loop: true });
  room.addPlaylist("zoneB", { loop: true });
  room.addTrackToContext("zoneA", { url: URL_A });
  room.addTrackToContext("zoneB", { url: URL_B });
  return room;
}

function startPlaying(
  room: RoomManager,
  contextId: string,
  url: string,
  positionSeconds: number,
  startedAgoMs: number,
  playbackRate?: number
) {
  const ok = room.updatePlaybackSchedulePlay(
    { type: "PLAY", audioSource: url, trackTimeSeconds: positionSeconds, contextId, playbackRate },
    epochNow() - startedAgoMs
  );
  expect(ok).toBe(true);
}

describe("broadcastPauseAll position capture", () => {
  it("captures each zone's position at the shared pause instant, scaled by its rate", () => {
    const room = createRoom();
    startPlaying(room, "zoneA", URL_A, 2, 20_000); // rate 1
    startPlaying(room, "zoneB", URL_B, 5, 20_000, SYNC_RATE); // beat-matched zone

    const before = epochNow();
    room.broadcastPauseAll(room.buildPauseAllActions(), stubServer);

    const a = room.getPlaylist("zoneA")!.playback;
    const b = room.getPlaylist("zoneB")!.playback;
    expect(a.type).toBe("paused");
    expect(b.type).toBe("paused");
    // Both froze at the same shared instant.
    expect(a.serverTimeToExecute).toBe(b.serverTimeToExecute);
    const pauseAt = a.serverTimeToExecute;
    expect(pauseAt).toBeGreaterThanOrEqual(before);

    // Position advanced by elapsed × rate up to the shared pause time.
    const elapsedA = (pauseAt - (before - 20_000)) / 1000;
    expect(a.trackPositionSeconds).toBeCloseTo(2 + elapsedA, 1);
    expect(b.trackPositionSeconds).toBeCloseTo(5 + SYNC_RATE * elapsedA, 1);
    // Tempo-sync rate survives the pause.
    expect(b.playbackRate).toBeCloseTo(SYNC_RATE, 12);
  });
});

describe("buildPlayAllActions resume mode", () => {
  it("resumes paused zones from captured position + rate, skips playing zones, restarts idle zones at 0", () => {
    const room = createRoom();
    room.addPlaylist("zoneIdle", { loop: true });
    room.addTrackToContext("zoneIdle", { url: URL_A }); // never played

    startPlaying(room, "zoneA", URL_A, 2, 20_000);
    startPlaying(room, "zoneB", URL_B, 5, 20_000, SYNC_RATE);
    room.broadcastPauseAll(room.buildPauseAllActions(), stubServer);
    // zoneA goes back to playing — resume must not touch it.
    startPlaying(room, "zoneA", URL_A, 0, 0);

    const actions = room.buildPlayAllActions(undefined, { resume: true });
    const byCtx = new Map(actions.map((a) => [a.contextId ?? "main", a]));

    expect(byCtx.has("zoneA")).toBe(false); // already playing → skipped
    const b = byCtx.get("zoneB")!;
    expect(b.trackTimeSeconds).toBe(room.getPlaylist("zoneB")!.playback.trackPositionSeconds);
    expect(b.trackTimeSeconds).toBeGreaterThan(5); // advanced past its start point
    expect(b.playbackRate).toBeCloseTo(SYNC_RATE, 12);
    const idle = byCtx.get("zoneIdle")!;
    expect(idle.trackTimeSeconds).toBe(0);
    expect(idle.playbackRate).toBeUndefined();
  });

  it("restart mode (no resume flag) still resets everything to 0 at rate 1", () => {
    const room = createRoom();
    startPlaying(room, "zoneB", URL_B, 5, 20_000, SYNC_RATE);
    room.broadcastPauseAll(room.buildPauseAllActions(), stubServer);

    const actions = room.buildPlayAllActions();
    for (const a of actions) {
      expect(a.trackTimeSeconds).toBe(0);
      expect(a.playbackRate).toBeUndefined();
    }
  });
});

describe("pause-all → resume-all round trip", () => {
  it("preserves each zone's position and rate, restarting all at one shared instant", () => {
    const room = createRoom();
    startPlaying(room, "zoneA", URL_A, 2, 20_000);
    startPlaying(room, "zoneB", URL_B, 5, 20_000, SYNC_RATE);

    room.broadcastPauseAll(room.buildPauseAllActions(), stubServer);
    const pausedA = room.getPlaylist("zoneA")!.playback.trackPositionSeconds;
    const pausedB = room.getPlaylist("zoneB")!.playback.trackPositionSeconds;

    // Resume through the same shared-timestamp flush the handler uses (demo path
    // = no load gate, but identical scheduling math).
    room.broadcastBatchedPlayImmediate(room.buildPlayAllActions(undefined, { resume: true }), stubServer);

    const a = room.getPlaylist("zoneA")!.playback;
    const b = room.getPlaylist("zoneB")!.playback;
    expect(a.type).toBe("playing");
    expect(b.type).toBe("playing");
    // Same shared restart instant → relative phase preserved.
    expect(a.serverTimeToExecute).toBe(b.serverTimeToExecute);
    expect(a.trackPositionSeconds).toBe(pausedA);
    expect(b.trackPositionSeconds).toBe(pausedB);
    expect(a.playbackRate).toBe(1);
    expect(b.playbackRate).toBeCloseTo(SYNC_RATE, 12);
  });
});
