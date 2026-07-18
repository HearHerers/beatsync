import { z } from "zod";
import { CHAT_CONSTANTS, LOW_PASS_CONSTANTS, MAP_CONSTANTS } from "../constants";
import { AudioSourceSchema, BeatgridSchema, MapMetadataSchema, MapTileLayerIdEnum, PositionSchema } from "./basic";
import { PLAYLIST_EXPORT_MAX_TRACKS } from "./playlist";
import { ShapeSchema } from "./shape";

// ROOM EVENTS
export const LocationSchema = z.object({
  flagEmoji: z.string(),
  flagSvgURL: z.string(),
  city: z.string(),
  country: z.string(),
  region: z.string(),
  countryCode: z.string(),
});

export const ClientActionEnum = z.enum([
  "PLAY",
  "PAUSE",
  "NTP_REQUEST",
  "START_SPATIAL_AUDIO",
  "STOP_SPATIAL_AUDIO",
  "REORDER_CLIENT",
  "SET_LISTENING_SOURCE",
  "MOVE_CLIENT",
  "SYNC", // Client joins late, requests sync
  "SET_ADMIN", // Set admin status
  "SET_PLAYBACK_CONTROLS", // Set playback controls
  "SEND_IP", // Send IP to server
  "LOAD_DEFAULT_TRACKS", // Load default tracks into empty queue
  "DELETE_AUDIO_SOURCES", // Delete audio sources from the room queue (non-default only)
  "SEARCH_MUSIC", // Search for music
  "STREAM_MUSIC", // Stream music
  "SET_GLOBAL_VOLUME", // Set global volume for all clients
  "SEND_CHAT_MESSAGE", // Send a chat message,
  "AUDIO_SOURCE_LOADED", // Audio source loaded in response to a LOAD_AUDIO_SOURCE request
  "SET_METRONOME", // Toggle metronome on/off for all clients
  "SET_LOW_PASS_FREQ", // Set low-pass filter cutoff frequency
  "SET_CONTEXT_LOOP", // Set the loop flag for a playlist context
  "SET_TRACK_BEATGRID", // Attach imported beatgrid data to a track (by URL)
  "SYNC_ZONES", // Beat-match a follower zone to a master zone (map rooms)
  "ADD_TRACK_TO_CONTEXT", // Append a track to a specific playlist context
  "REMOVE_TRACK_FROM_CONTEXT", // Remove a track from a specific playlist context
  "REORDER_TRACK_IN_CONTEXT", // Reorder the tracks within a specific playlist context
  "IMPORT_TRACKS_TO_CONTEXT", // Bulk-add tracks (from an imported playlist file) to a context
  "PLAY_ALL_CONTEXTS", // Start every eligible playlist context aligned to one shared serverTimeToExecute
  "PAUSE_ALL_CONTEXTS", // Pause every currently-playing playlist context aligned to one shared serverTimeToExecute
  // Map-room geometry actions. Audio behavior of a shape's playlist (tracks,
  // play/pause, loop) flows through the unified per-context actions with
  // contextId = shape.id — there are no shape-specific audio actions.
  "ADD_SHAPE",
  "UPDATE_SHAPE",
  "DELETE_SHAPE",
  "CLEAR_SHAPES",
  "SET_SHAPE_FALLOFF",
  "SET_SHAPE_NAME",
  "SET_SHAPE_GROUP",
  "SET_MAP_METADATA",
  "SET_ROOM_NAME",
  "SET_USERNAME",
  "SET_DEFAULT_TILE_LAYER", // Admin sets the room-wide default base map
  "SET_GEO_POSITION", // Client GPS update
  "SET_VISIBILITY", // Tab visibility (hidden tabs still receive sync)
]);

export const NTPRequestPacketSchema = z.object({
  type: z.literal(ClientActionEnum.enum.NTP_REQUEST),
  t0: z.number(), // Client send timestamp
  t1: z.number().optional(), // Server receive timestamp (will be set by the server)
  clientRTT: z.number().optional(), // Client's current RTT estimate in ms
  clientCompensationMs: z.number().optional(), // Total local compensation (outputLatency + nudge) the client subtracts from wait time
  clientNudgeMs: z.number().optional(), // Manual timing nudge set by the user (persisted per-client)
  probeGroupId: z.number(), // Coded probes (Huygens): shared ID for both probes in a pair
  probeGroupIndex: z.union([z.literal(0), z.literal(1)]), // Coded probes: 0 = first probe, 1 = second probe
});

export const PlayActionSchema = z.object({
  type: z.literal(ClientActionEnum.enum.PLAY),
  trackTimeSeconds: z.number(),
  audioSource: z.string(),
  /**
   * Which playback context (playlist) to operate on. Omitted = "main" — preserves
   * audio-room behavior. Future room types (e.g. map rooms) use per-shape contexts.
   */
  contextId: z.string().optional(),
  /**
   * Tempo-sync rate for zone beat-matching. Omitted = 1 (normal speed). Only the
   * server sets this (SYNC_ZONES computes it); it rides here because the
   * SCHEDULED_ACTION broadcast reuses this schema as its payload.
   */
  playbackRate: z.number().positive().optional(),
});

export const PauseActionSchema = z.object({
  type: z.literal(ClientActionEnum.enum.PAUSE),
  audioSource: z.string(),
  trackTimeSeconds: z.number(),
  /** See PlayActionSchema.contextId. Omitted = "main". */
  contextId: z.string().optional(),
});

const StartSpatialAudioSchema = z.object({
  type: z.literal(ClientActionEnum.enum.START_SPATIAL_AUDIO),
});

const StopSpatialAudioSchema = z.object({
  type: z.literal(ClientActionEnum.enum.STOP_SPATIAL_AUDIO),
});

const ReorderClientSchema = z.object({
  type: z.literal(ClientActionEnum.enum.REORDER_CLIENT),
  clientId: z.string(),
});

const SetListeningSourceSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_LISTENING_SOURCE),
  x: z.number(),
  y: z.number(),
});

const MoveClientSchema = z.object({
  type: z.literal(ClientActionEnum.enum.MOVE_CLIENT),
  clientId: z.string(),
  position: PositionSchema,
});
export type MoveClientType = z.infer<typeof MoveClientSchema>;

const ClientRequestSyncSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SYNC),
});
export type ClientRequestSyncType = z.infer<typeof ClientRequestSyncSchema>;

const LoadDefaultTracksSchema = z.object({
  type: z.literal(ClientActionEnum.enum.LOAD_DEFAULT_TRACKS),
});

const DeleteAudioSourcesSchema = z.object({
  type: z.literal(ClientActionEnum.enum.DELETE_AUDIO_SOURCES),
  urls: z.array(z.string()).min(1),
});

const SetAdminSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_ADMIN),
  clientId: z.string(), // The client to set admin status for
  isAdmin: z.boolean(), // The new admin status
});

export const PlaybackControlsPermissionsEnum = z.enum(["ADMIN_ONLY", "EVERYONE"]);
export type PlaybackControlsPermissionsType = z.infer<typeof PlaybackControlsPermissionsEnum>;

export const SetPlaybackControlsSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_PLAYBACK_CONTROLS),
  permissions: PlaybackControlsPermissionsEnum,
});

export const SendLocationSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SEND_IP),
  location: LocationSchema,
});

export const SearchMusicSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SEARCH_MUSIC),
  query: z.string(),
  offset: z.number().min(0).default(0).optional(),
});

export const StreamMusicSchema = z.object({
  type: z.literal(ClientActionEnum.enum.STREAM_MUSIC),
  // String to support Navidrome/Subsonic opaque IDs (numeric provider IDs are
  // sent as strings too). See TrackSchema.id in provider.ts. Coerce so a tab
  // loaded before this field was narrowed string (it sent a numeric id) doesn't
  // fail WSRequestSchema.parse and get silently dropped (#124/5).
  trackId: z.coerce.string(),
  trackName: z.string().optional(),
  /** Provider-reported track length (seconds) — stamped onto the stored track
   * so beatgrid matching can duration-verify without waiting for a decode. */
  trackDurationSec: z.number().positive().optional(),
  /** Route the streamed track into this playlist context (e.g. a shape.id in
   * map rooms). Omitted = the room-wide "main" playlist (audio rooms). */
  contextId: z.string().optional(),
});

export const SetGlobalVolumeSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_GLOBAL_VOLUME),
  volume: z.number().min(0).max(1), // 0-1 range
});

export const SendChatMessageSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SEND_CHAT_MESSAGE),
  text: z.string().max(CHAT_CONSTANTS.MAX_MESSAGE_LENGTH),
});

export const AudioSourceLoadedSchema = z.object({
  type: z.literal(ClientActionEnum.enum.AUDIO_SOURCE_LOADED),
  source: AudioSourceSchema,
  /** Which playback context's load gate to advance. Omitted = "main". */
  contextId: z.string().optional(),
});

export const SetMetronomeSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_METRONOME),
  enabled: z.boolean(),
});

export const SetLowPassFreqSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_LOW_PASS_FREQ),
  freq: z.number().min(LOW_PASS_CONSTANTS.MIN_FREQ).max(LOW_PASS_CONSTANTS.MAX_FREQ),
});

/**
 * Toggle the loop flag on a playlist context. When true, the current track
 * loops continuously until the user advances. Map zones default true; audio
 * rooms default false. Omitted contextId = "main".
 */
export const SetContextLoopSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_CONTEXT_LOOP),
  loop: z.boolean(),
  contextId: z.string().optional(),
});

/**
 * Attach beatgrid data (imported from rekordbox-integration/ JSON) to a track.
 * Applies to every playlist context containing the URL — the grid is a property
 * of the audio file, not of any one zone.
 */
export const SetTrackBeatgridSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_TRACK_BEATGRID),
  url: z.string(),
  beatgrid: BeatgridSchema,
});
export type SetTrackBeatgridType = z.infer<typeof SetTrackBeatgridSchema>;

/**
 * Beat-match the follower zone's playing track to the master zone's (map rooms).
 * One-shot, CDJ-style: both zones must be playing tracks with beatgrids. The
 * server computes the follower's playbackRate (= master BPM / follower BPM) and
 * a bar-quantized phase anchor, then reschedules ONLY the follower — the master
 * is never interrupted.
 */
export const SyncZonesSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SYNC_ZONES),
  masterContextId: z.string(),
  followerContextId: z.string(),
});
export type SyncZonesType = z.infer<typeof SyncZonesSchema>;

/**
 * Append a track to a specific context's playlist. For audio rooms this is
 * equivalent to /upload/complete adding to the room queue; for map rooms it
 * adds to a specific shape's playlist. Omitted contextId = "main".
 */
export const AddTrackToContextSchema = z.object({
  type: z.literal(ClientActionEnum.enum.ADD_TRACK_TO_CONTEXT),
  source: AudioSourceSchema,
  contextId: z.string().optional(),
});
export type AddTrackToContextType = z.infer<typeof AddTrackToContextSchema>;

export const RemoveTrackFromContextSchema = z.object({
  type: z.literal(ClientActionEnum.enum.REMOVE_TRACK_FROM_CONTEXT),
  url: z.string(),
  contextId: z.string().optional(),
});
export type RemoveTrackFromContextType = z.infer<typeof RemoveTrackFromContextSchema>;

/**
 * Reorder the tracks within a specific context's playlist. `orderedUrls` is the
 * full new ordering by track URL — the server already holds the source objects,
 * so only the order needs to travel. Works for any context (audio-room "main"
 * and map-room shape playlists alike). Omitted contextId = "main".
 */
export const ReorderTrackInContextSchema = z.object({
  type: z.literal(ClientActionEnum.enum.REORDER_TRACK_IN_CONTEXT),
  orderedUrls: z.array(z.string()).min(1),
  contextId: z.string().optional(),
});
export type ReorderTrackInContextType = z.infer<typeof ReorderTrackInContextSchema>;

/**
 * Bulk-add tracks to a context from an imported playlist file. Carries only the
 * track URLs — display names derive from the URL, and the source playlist's loop
 * flag is intentionally not applied (the destination keeps its setting). The
 * server classifies each URL (same-room reference vs. same-bucket re-host vs.
 * foreign-host reference) when adding. Omitted contextId = "main".
 */
export const ImportTracksToContextSchema = z.object({
  type: z.literal(ClientActionEnum.enum.IMPORT_TRACKS_TO_CONTEXT),
  urls: z.array(z.string().url()).min(1).max(PLAYLIST_EXPORT_MAX_TRACKS),
  contextId: z.string().optional(),
});
export type ImportTracksToContextType = z.infer<typeof ImportTracksToContextSchema>;

/**
 * Start every eligible playlist context in the room aligned to one shared
 * serverTimeToExecute. Each context starts at trackTimeSeconds=0 — restarts
 * currently-playing contexts so they re-lock in phase. "Eligible" = playlist
 * has at least one track; an empty audioSource defaults to tracks[0].url.
 * Optional contextIds filter restricts the operation to a subset.
 */
export const PlayAllContextsSchema = z.object({
  type: z.literal(ClientActionEnum.enum.PLAY_ALL_CONTEXTS),
  contextIds: z.array(z.string()).optional(),
  /**
   * true = resume: paused contexts restart from their stored position (and
   * tempo-sync rate), already-playing contexts are left alone. Because
   * PAUSE_ALL captures every position at one shared instant and resume
   * restarts them at one shared instant, relative phase between zones —
   * including beat-sync lock — survives a pause/resume cycle.
   * false/omitted = restart every context from 0 at rate 1 (existing behavior).
   */
  resume: z.boolean().optional(),
});
export type PlayAllContextsType = z.infer<typeof PlayAllContextsSchema>;

/**
 * Pause every currently-playing playlist context in the room with one shared
 * serverTimeToExecute. Contexts that aren't playing are skipped. Optional
 * contextIds filter restricts the operation to a subset.
 */
export const PauseAllContextsSchema = z.object({
  type: z.literal(ClientActionEnum.enum.PAUSE_ALL_CONTEXTS),
  contextIds: z.array(z.string()).optional(),
});
export type PauseAllContextsType = z.infer<typeof PauseAllContextsSchema>;

// ── Map-room geometry ──────────────────────────────────────────────
// Audio behavior (tracks, play/pause, loop) flows through the unified per-
// context actions with contextId = shape.id. The shape actions below only
// manage geometry + map-specific behavior (audible radius, transport group).

export const AddShapeSchema = z.object({
  type: z.literal(ClientActionEnum.enum.ADD_SHAPE),
  shape: ShapeSchema,
});
export type AddShapeType = z.infer<typeof AddShapeSchema>;

export const UpdateShapeSchema = z.object({
  type: z.literal(ClientActionEnum.enum.UPDATE_SHAPE),
  shapeId: z.string(),
  coordinates: z.unknown(),
});
export type UpdateShapeType = z.infer<typeof UpdateShapeSchema>;

export const DeleteShapeSchema = z.object({
  type: z.literal(ClientActionEnum.enum.DELETE_SHAPE),
  shapeId: z.string(),
});
export type DeleteShapeType = z.infer<typeof DeleteShapeSchema>;

export const ClearShapesSchema = z.object({
  type: z.literal(ClientActionEnum.enum.CLEAR_SHAPES),
});
export type ClearShapesType = z.infer<typeof ClearShapesSchema>;

export const SetShapeFalloffSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_SHAPE_FALLOFF),
  shapeId: z.string(),
  falloffMeters: z.number().min(MAP_CONSTANTS.MIN_FALLOFF_METERS).max(MAP_CONSTANTS.MAX_FALLOFF_METERS),
});
export type SetShapeFalloffType = z.infer<typeof SetShapeFalloffSchema>;

export const SetShapeNameSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_SHAPE_NAME),
  shapeId: z.string(),
  /** Empty string clears the name (UI falls back to "Zone <id>"). */
  name: z.string().max(80),
});
export type SetShapeNameType = z.infer<typeof SetShapeNameSchema>;

export const SetShapeGroupSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_SHAPE_GROUP),
  shapeId: z.string(),
  groupId: z.string().nullable(),
});
export type SetShapeGroupType = z.infer<typeof SetShapeGroupSchema>;

export const SetMapMetadataSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_MAP_METADATA),
  metadata: MapMetadataSchema,
});
export type SetMapMetadataType = z.infer<typeof SetMapMetadataSchema>;

export const SetRoomNameSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_ROOM_NAME),
  /** Empty string clears the name (UI falls back to "Room <id>"). */
  roomName: z.string().max(80),
});
export type SetRoomNameType = z.infer<typeof SetRoomNameSchema>;
export const SetUsernameSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_USERNAME),
  /** Display name for this client. Trimmed + length-capped server-side. */
  username: z.string().min(1).max(40),
});
export type SetUsernameType = z.infer<typeof SetUsernameSchema>;

export const SetDefaultTileLayerSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_DEFAULT_TILE_LAYER),
  tileLayerId: MapTileLayerIdEnum,
});
export type SetDefaultTileLayerType = z.infer<typeof SetDefaultTileLayerSchema>;

export const SetGeoPositionSchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_GEO_POSITION),
  lat: z.number(),
  lng: z.number(),
});
export type SetGeoPositionType = z.infer<typeof SetGeoPositionSchema>;

export const SetVisibilitySchema = z.object({
  type: z.literal(ClientActionEnum.enum.SET_VISIBILITY),
  isHidden: z.boolean(),
});
export type SetVisibilityType = z.infer<typeof SetVisibilitySchema>;

export const WSRequestSchema = z.discriminatedUnion("type", [
  PlayActionSchema,
  PauseActionSchema,
  NTPRequestPacketSchema,
  StartSpatialAudioSchema,
  StopSpatialAudioSchema,
  ReorderClientSchema,
  SetListeningSourceSchema,
  MoveClientSchema,
  ClientRequestSyncSchema,
  SetAdminSchema,
  SetPlaybackControlsSchema,
  SendLocationSchema,
  LoadDefaultTracksSchema,
  DeleteAudioSourcesSchema,
  SearchMusicSchema,
  StreamMusicSchema,
  SetGlobalVolumeSchema,
  SendChatMessageSchema,
  AudioSourceLoadedSchema,
  SetMetronomeSchema,
  SetLowPassFreqSchema,
  SetContextLoopSchema,
  SetTrackBeatgridSchema,
  SyncZonesSchema,
  AddTrackToContextSchema,
  RemoveTrackFromContextSchema,
  ReorderTrackInContextSchema,
  ImportTracksToContextSchema,
  PlayAllContextsSchema,
  PauseAllContextsSchema,
  // Map-room geometry
  AddShapeSchema,
  UpdateShapeSchema,
  DeleteShapeSchema,
  ClearShapesSchema,
  SetShapeFalloffSchema,
  SetShapeNameSchema,
  SetShapeGroupSchema,
  SetMapMetadataSchema,
  SetRoomNameSchema,
  SetUsernameSchema,
  SetDefaultTileLayerSchema,
  SetGeoPositionSchema,
  SetVisibilitySchema,
]);
export type WSRequestType = z.infer<typeof WSRequestSchema>;
export type PlayActionType = z.infer<typeof PlayActionSchema>;
export type PauseActionType = z.infer<typeof PauseActionSchema>;
export type ReorderClientType = z.infer<typeof ReorderClientSchema>;
export type SetListeningSourceType = z.infer<typeof SetListeningSourceSchema>;

// Mapped type to access request types by their type field
export type ExtractWSRequestFrom = {
  [K in WSRequestType["type"]]: Extract<WSRequestType, { type: K }>;
};
