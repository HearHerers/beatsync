// Pure math for zone beat-matching (SYNC_ZONES). Given the authoritative
// playback state + beatgrid of a master and a follower zone, compute when and
// how to reschedule the follower so its downbeats land on the master's.
//
// Everything is in server-clock epoch ms / track seconds. The core identity:
// a track scheduled at (P, T) with rate r is at position P + r·(t − T)/1000
// at server time t. Once r ≠ 1, buffer-time ≠ wall-time — every conversion
// between the two must go through r.

import type { BeatgridType } from "@beatsync/shared";

export interface ZoneSyncState {
  /** trackPositionSeconds at the moment the current schedule executed. */
  positionSeconds: number;
  /** serverTimeToExecute of the current schedule (epoch ms). */
  atServerTime: number;
  /** Current tempo-sync rate (1 = normal). */
  playbackRate: number;
  beatgrid: BeatgridType;
}

export interface ZoneSyncResult {
  /** T*: the master downbeat (server time, epoch ms) both zones align on. */
  anchorServerTime: number;
  /** Rate the follower must play at: master effective BPM / follower BPM. */
  followerRate: number;
  /** Follower buffer position (seconds) at T* — its downbeat nearest where it would have been. */
  followerTrackTimeSeconds: number;
  /** Master position at T*, for logging/diagnostics. */
  masterTrackTimeSeconds: number;
}

/** Track position of a zone at server time t (ms). */
export function zonePositionAt(state: ZoneSyncState, t: number): number {
  return state.positionSeconds + (state.playbackRate * (t - state.atServerTime)) / 1000;
}

/**
 * Compute the follower's new schedule. `earliestServerTime` is the soonest the
 * room can schedule (getScheduledExecutionTime()) — the anchor is the first
 * master downbeat at or after it, so every client has its usual lead time.
 */
export function computeZoneSync(
  master: ZoneSyncState,
  follower: ZoneSyncState,
  earliestServerTime: number
): ZoneSyncResult {
  const gm = master.beatgrid;
  const gf = follower.beatgrid;

  // Master bar length in master-track seconds, and the first bar-aligned
  // position at/after where the master will be at the earliest schedule time.
  const masterBarSec = (gm.beatsPerBar * 60) / gm.bpm;
  const masterPosAtEarliest = zonePositionAt(master, earliestServerTime);
  const barsFromFirstDownbeat = Math.ceil((masterPosAtEarliest - gm.firstDownbeatSec) / masterBarSec);
  const masterAnchorPos = gm.firstDownbeatSec + barsFromFirstDownbeat * masterBarSec;

  // Map that master position back to server time through the master's rate.
  const anchorServerTime =
    master.atServerTime + ((masterAnchorPos - master.positionSeconds) * 1000) / master.playbackRate;

  // Follower rate: match the master's *effective* tempo (its grid BPM × its
  // current rate) so chaining/syncing to an already-synced master works.
  const followerRate = (gm.bpm * master.playbackRate) / gf.bpm;

  // Where the follower would be at T* if left alone, snapped to its nearest
  // own downbeat — the minimal bar-quantized jump (CDJ sync behavior).
  const followerBarSec = (gf.beatsPerBar * 60) / gf.bpm;
  const followerFreePos = zonePositionAt(follower, anchorServerTime);
  const followerBars = Math.max(0, Math.round((followerFreePos - gf.firstDownbeatSec) / followerBarSec));
  const followerTrackTimeSeconds = gf.firstDownbeatSec + followerBars * followerBarSec;

  return {
    anchorServerTime,
    followerRate,
    followerTrackTimeSeconds,
    masterTrackTimeSeconds: masterAnchorPos,
  };
}
