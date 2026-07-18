// Tests for zone beat-matching: the pure computeZoneSync math and the
// RoomManager.syncZones / setTrackBeatgrid state updates.
//
// Grid values are REAL extracted rekordbox data (rekordbox-integration/):
//   Heat 3 (Shinichi Atobe): 123.0 BPM, first downbeat 0.052s
//   Bump Talkin (Paul Johnson): 132.4 BPM, first downbeat 0.004s

import type { BeatgridType } from "@beatsync/shared";
import { epochNow, MAIN_CONTEXT_ID } from "@beatsync/shared";
import { describe, expect, it } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { computeZoneSync, zonePositionAt, type ZoneSyncState } from "@/lib/zoneSync";
import { RoomManager } from "@/managers/RoomManager";

mockR2();

const HEAT3: BeatgridType = { bpm: 123.0, firstBeatSec: 0.052, firstDownbeatSec: 0.052, beatsPerBar: 4 };
const BUMP: BeatgridType = { bpm: 132.4, firstBeatSec: 0.004, firstDownbeatSec: 0.004, beatsPerBar: 4 };

const HEAT3_BAR_SEC = (4 * 60) / 123.0; // ≈ 1.95122
const BUMP_BAR_SEC = (4 * 60) / 132.4; // ≈ 1.81269

/** Beats elapsed since a grid's first downbeat at a given track position. */
function beatsAt(grid: BeatgridType, positionSeconds: number): number {
  return ((positionSeconds - grid.firstDownbeatSec) * grid.bpm) / 60;
}

function expectInteger(x: number, epsilon = 1e-9) {
  expect(Math.abs(x - Math.round(x))).toBeLessThan(epsilon);
}

describe("computeZoneSync", () => {
  // Master (Heat 3) started 30s ago at position 0; follower (Bump Talkin)
  // started 12s ago at position 5. Earliest schedulable moment is 500ms out.
  const now = 1_700_000_000_000;
  const master: ZoneSyncState = { positionSeconds: 0, atServerTime: now - 30_000, playbackRate: 1, beatgrid: HEAT3 };
  const follower: ZoneSyncState = { positionSeconds: 5, atServerTime: now - 12_000, playbackRate: 1, beatgrid: BUMP };
  const earliest = now + 500;

  it("anchors on an exact master downbeat at/after the earliest schedulable time", () => {
    const r = computeZoneSync(master, follower, earliest);
    expect(r.anchorServerTime).toBeGreaterThanOrEqual(earliest);
    // The anchor is less than one bar past the earliest moment.
    expect(r.anchorServerTime - earliest).toBeLessThan(HEAT3_BAR_SEC * 1000);
    // Master's position at the anchor is a whole number of bars from its downbeat.
    expectInteger((r.masterTrackTimeSeconds - HEAT3.firstDownbeatSec) / HEAT3_BAR_SEC);
    // And consistent with the master's motion equation. (Tolerance: the round
    // trip through epoch-ms floats costs ~1e-8s at 1.7e12 magnitude.)
    expect(zonePositionAt(master, r.anchorServerTime)).toBeCloseTo(r.masterTrackTimeSeconds, 6);
  });

  it("computes the exact BPM ratio as the follower rate", () => {
    const r = computeZoneSync(master, follower, earliest);
    expect(r.followerRate).toBeCloseTo(123.0 / 132.4, 12);
  });

  it("quantizes the follower to its own downbeat nearest its free-running position", () => {
    const r = computeZoneSync(master, follower, earliest);
    expectInteger((r.followerTrackTimeSeconds - BUMP.firstDownbeatSec) / BUMP_BAR_SEC);
    // Bar-quantized minimal jump: at most half a follower bar away from where
    // the follower would have been anyway.
    const freePos = zonePositionAt(follower, r.anchorServerTime);
    expect(Math.abs(r.followerTrackTimeSeconds - freePos)).toBeLessThanOrEqual(BUMP_BAR_SEC / 2 + 1e-9);
  });

  it("phase-locks: master and follower advance beats at the same wall rate from the anchor", () => {
    const r = computeZoneSync(master, follower, earliest);
    for (const dtMs of [0, 1000, 7777, 60_000, 300_000]) {
      const t = r.anchorServerTime + dtMs;
      const masterBeats = beatsAt(HEAT3, zonePositionAt(master, t));
      const followerPos = r.followerTrackTimeSeconds + (r.followerRate * dtMs) / 1000;
      const followerBeats = beatsAt(BUMP, followerPos);
      // Both are whole-bar aligned at the anchor, so the fractional beat (and
      // beat-in-bar) must match at every later moment.
      const phaseDiff = (((masterBeats - followerBeats) % 4) + 4) % 4;
      expect(Math.min(phaseDiff, 4 - phaseDiff)).toBeLessThan(1e-6);
    }
  });

  it("chains: syncing to an already-synced master matches its effective tempo", () => {
    // Master is Bump Talkin already rate-shifted to Heat 3's tempo (rate 123/132.4).
    const syncedMaster: ZoneSyncState = {
      positionSeconds: 10,
      atServerTime: now - 5_000,
      playbackRate: 123.0 / 132.4,
      beatgrid: BUMP,
    };
    const r = computeZoneSync(syncedMaster, follower, earliest);
    // Effective master BPM = 132.4 × (123/132.4) = 123 → follower rate = 123/132.4.
    expect(r.followerRate).toBeCloseTo(123.0 / 132.4, 12);
  });

  it("handles a paused-at-zero follower (position snaps to its first downbeat region)", () => {
    const freshFollower: ZoneSyncState = {
      positionSeconds: 0,
      atServerTime: earliest,
      playbackRate: 1,
      beatgrid: BUMP,
    };
    const r = computeZoneSync(master, freshFollower, earliest);
    expectInteger((r.followerTrackTimeSeconds - BUMP.firstDownbeatSec) / BUMP_BAR_SEC);
    expect(r.followerTrackTimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("RoomManager.setTrackBeatgrid / syncZones", () => {
  const URL_A = "https://example.com/heat3.flac";
  const URL_B = "https://example.com/bump.flac";

  function createMapRoom(): RoomManager {
    const room = new RoomManager("zone-sync-room");
    room.addPlaylist("zoneA", { loop: true });
    room.addPlaylist("zoneB", { loop: true });
    room.addTrackToContext("zoneA", { url: URL_A });
    room.addTrackToContext("zoneB", { url: URL_B });
    return room;
  }

  function startPlaying(room: RoomManager, contextId: string, url: string, positionSeconds: number) {
    const ok = room.updatePlaybackSchedulePlay(
      { type: "PLAY", audioSource: url, trackTimeSeconds: positionSeconds, contextId },
      epochNow() - 10_000 // started 10s ago
    );
    expect(ok).toBe(true);
  }

  it("stamps a beatgrid onto every occurrence of the URL", () => {
    const room = createMapRoom();
    room.addTrackToContext("zoneB", { url: URL_A }); // same track in two zones
    // Stamps every occurrence: zoneA + zoneB + the Room Pool (main context),
    // since addTrackToContext mirrors every zone track into the pool.
    expect(room.setTrackBeatgrid(URL_A, HEAT3)).toBe(3);
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid).toEqual(HEAT3);
    expect(room.getPlaylist("zoneB")!.tracks[1].beatgrid).toEqual(HEAT3);
    expect(room.getPlaylist(MAIN_CONTEXT_ID)!.tracks.find((t) => t.url === URL_A)!.beatgrid).toEqual(HEAT3);
    expect(room.setTrackBeatgrid("https://example.com/nope.mp3", HEAT3)).toBe(0);
  });

  it("carries an existing beatgrid onto a track added to a zone from the pool", () => {
    const room = new RoomManager("grid-inherit-room");
    room.addPlaylist("zoneA", { loop: true });
    // Track lives only in the pool with a beatgrid (imported before assignment).
    room.addTrackToContext(MAIN_CONTEXT_ID, { url: URL_A });
    expect(room.setTrackBeatgrid(URL_A, HEAT3)).toBe(1); // pool only, so far
    // Assigning it to a zone should inherit the pool copy's grid.
    room.addTrackToContext("zoneA", { url: URL_A });
    expect(room.getPlaylist("zoneA")!.tracks.find((t) => t.url === URL_A)!.beatgrid).toEqual(HEAT3);
  });

  it("rejects sync when preconditions are unmet", () => {
    const room = createMapRoom();
    expect(room.syncZones("zoneA", "zoneA")).toBeInstanceOf(Error);
    expect(room.syncZones("zoneA", "missing")).toBeInstanceOf(Error);
    // Not playing yet.
    expect(room.syncZones("zoneA", "zoneB")).toBeInstanceOf(Error);
    startPlaying(room, "zoneA", URL_A, 0);
    startPlaying(room, "zoneB", URL_B, 5);
    // Playing but no beatgrids.
    expect(room.syncZones("zoneA", "zoneB")).toBeInstanceOf(Error);
    room.setTrackBeatgrid(URL_A, HEAT3);
    expect(room.syncZones("zoneA", "zoneB")).toBeInstanceOf(Error); // follower still ungridded
  });

  it("updates the follower's authoritative playback state and leaves the master untouched", () => {
    const room = createMapRoom();
    startPlaying(room, "zoneA", URL_A, 0);
    startPlaying(room, "zoneB", URL_B, 5);
    room.setTrackBeatgrid(URL_A, HEAT3);
    room.setTrackBeatgrid(URL_B, BUMP);

    const masterBefore = { ...room.getPlaylist("zoneA")!.playback };
    const result = room.syncZones("zoneA", "zoneB");
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;

    expect(result.audioSource).toBe(URL_B);
    expect(result.followerRate).toBeCloseTo(123.0 / 132.4, 12);
    expect(result.anchorServerTime).toBeGreaterThan(epochNow());

    const follower = room.getPlaylist("zoneB")!.playback;
    expect(follower.type).toBe("playing");
    expect(follower.playbackRate).toBeCloseTo(123.0 / 132.4, 12);
    expect(follower.serverTimeToExecute).toBe(result.anchorServerTime);
    expect(follower.trackPositionSeconds).toBe(result.followerTrackTimeSeconds);
    expectInteger((follower.trackPositionSeconds - BUMP.firstDownbeatSec) / BUMP_BAR_SEC);

    expect(room.getPlaylist("zoneA")!.playback).toEqual(masterBefore);
  });

  it("a subsequent normal PLAY on the follower resets its rate to 1", () => {
    const room = createMapRoom();
    startPlaying(room, "zoneA", URL_A, 0);
    startPlaying(room, "zoneB", URL_B, 5);
    room.setTrackBeatgrid(URL_A, HEAT3);
    room.setTrackBeatgrid(URL_B, BUMP);
    expect(room.syncZones("zoneA", "zoneB")).not.toBeInstanceOf(Error);
    expect(room.getPlaylist("zoneB")!.playback.playbackRate).not.toBe(1);

    startPlaying(room, "zoneB", URL_B, 0);
    expect(room.getPlaylist("zoneB")!.playback.playbackRate).toBe(1);
  });
});
