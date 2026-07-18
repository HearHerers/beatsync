// Per-context playlist primitive. A "playback context" is anything a room can play
// audio inside of, identified by a string id. Audio rooms have a single context
// "main"; map rooms have one context per shape. The same primitive backs both — the
// only difference is how many contexts a room owns.

import { z } from "zod";
import { AudioSourceSchema } from "./basic";

/** The id used when no contextId is supplied (audio rooms, back-compat). */
export const MAIN_CONTEXT_ID = "main";

export const PlaylistPlaybackStateSchema = z.object({
  type: z.enum(["playing", "paused"]),
  /** URL of the audio source currently scheduled to play. "" when paused/idle. */
  audioSource: z.string(),
  /** Index into the playlist's tracks. 0 when paused/idle. */
  trackIndex: z.number().int().nonnegative().default(0),
  /** epoch ms — when the scheduled action was set to execute. */
  serverTimeToExecute: z.number(),
  /** Position in the current track at the time of the action. */
  trackPositionSeconds: z.number(),
  /**
   * Tempo-sync rate (zone beat-matching). 1 = normal. When ≠ 1 the track's
   * buffer position advances at `rate` × wall-clock, so EVERY position
   * computation of the form "position + elapsed" must scale elapsed by this.
   * Lives in authoritative state so resumes/late joins reconstruct it.
   */
  playbackRate: z.number().positive().default(1),
});
export type PlaylistPlaybackStateType = z.infer<typeof PlaylistPlaybackStateSchema>;

export const INITIAL_PLAYLIST_PLAYBACK_STATE: PlaylistPlaybackStateType = {
  type: "paused",
  audioSource: "",
  trackIndex: 0,
  serverTimeToExecute: 0,
  trackPositionSeconds: 0,
  playbackRate: 1,
};

/**
 * Server-authoritative playlist state broadcast to clients. Audio rooms have one
 * playlist with id="main"; map rooms have one per shape. The `loop` flag
 * determines what happens when the current track ends:
 *   - Map zones: true = advance through the whole playlist and wrap back to the
 *     top at the end; false = play through once and stop (see mapAudio #99).
 *   - Audio room: client-driven autoplay advances the queue; loop unused here.
 */
export const PlaylistSchema = z.object({
  id: z.string(),
  tracks: z.array(AudioSourceSchema),
  loop: z.boolean().default(false),
  playbackState: PlaylistPlaybackStateSchema,
});
export type PlaylistType = z.infer<typeof PlaylistSchema>;

// ── Portable playlist file (import/export) ──────────────────────────
//
// A self-describing JSON document a curator can download from one zone (or
// audio-room) playlist and import into another — possibly in a different room.
// Tracks travel as URLs; `name` is a human-readable label (derived from the
// URL) carried only for display/diffing before audio loads. `loop` is recorded
// for reference but NOT applied on import (the destination keeps its setting).

/** Current export format version. Bump on breaking shape changes. */
export const PLAYLIST_EXPORT_VERSION = 1;

/** Hard cap on tracks accepted from an imported file (abuse guard). */
export const PLAYLIST_EXPORT_MAX_TRACKS = 1000;

export const PlaylistExportTrackSchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
});
export type PlaylistExportTrackType = z.infer<typeof PlaylistExportTrackSchema>;

export const PlaylistExportSchema = z.object({
  /** Format discriminator + version. */
  beatsyncPlaylist: z.literal(PLAYLIST_EXPORT_VERSION),
  /** Optional label (e.g. "Zone abc123"). */
  name: z.string().optional(),
  /** The source playlist's loop flag, for reference only (not applied). */
  loop: z.boolean().optional(),
  /** epoch ms when exported. */
  exportedAt: z.number().optional(),
  /** Room the playlist was exported from, for provenance/debugging. */
  sourceRoomId: z.string().optional(),
  tracks: z.array(PlaylistExportTrackSchema).max(PLAYLIST_EXPORT_MAX_TRACKS),
});
export type PlaylistExportType = z.infer<typeof PlaylistExportSchema>;
