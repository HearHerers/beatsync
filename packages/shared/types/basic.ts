import { z } from "zod";
import { CHAT_CONSTANTS } from "../constants";

export const GRID = {
  SIZE: 100,
  ORIGIN_X: 50,
  ORIGIN_Y: 50,
  CLIENT_RADIUS: 25,
} as const;

export const PositionSchema = z.object({
  x: z.number().min(0).max(GRID.SIZE),
  y: z.number().min(0).max(GRID.SIZE),
});
export type PositionType = z.infer<typeof PositionSchema>;

// Real-world geographic coordinate. Used by map rooms for client presence and
// shape geometry (Leaflet stores latlng pairs, which we mirror here for typing).
export const GeoPositionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPositionType = z.infer<typeof GeoPositionSchema>;

// Discriminator for which experience a room offers. Set by the first connecting
// client (WS upgrade query param) and immutable for the room's lifetime.
export const RoomTypeEnum = z.enum(["audio", "map"]);
export type RoomTypeValue = z.infer<typeof RoomTypeEnum>;

// Curator-controlled default Leaflet view for a map room.
export const MapMetadataSchema = z.object({
  center: z.tuple([z.number(), z.number()]),
  zoom: z.number().min(0).max(22),
});
export type MapMetadataType = z.infer<typeof MapMetadataSchema>;

// Selectable base-map tile layers for map rooms. The admin-chosen default is
// synced room-wide; the actual tile URLs live client-side (see MapCanvas). The
// "mapbox" layer needs a build-time token — clients without one fall back to esri.
export const MapTileLayerIdEnum = z.enum(["mapbox", "esri", "michigan", "street"]);
export type MapTileLayerId = z.infer<typeof MapTileLayerIdEnum>;

/**
 * Compact constant-tempo beatgrid for a track, extracted from DJ software
 * (see rekordbox-integration/). Sufficient for quantized electronic music:
 * beat k lands at firstDownbeatSec + k·60/bpm. Tracks whose grid is dynamic
 * (multiple tempos) are not representable here and stay un-synced in v1.
 */
export const BeatgridSchema = z.object({
  bpm: z.number().positive(),
  /** Seconds into the track of the first gridded beat (any beat-in-bar). */
  firstBeatSec: z.number().min(0),
  /** Seconds into the track of the first downbeat (beat 1 of a bar). */
  firstDownbeatSec: z.number().min(0),
  beatsPerBar: z.number().int().positive().default(4),
});
export type BeatgridType = z.infer<typeof BeatgridSchema>;

/**
 * Where a track's beatgrid came from. "manual" = imported by a curator
 * (SET_TRACK_BEATGRID); "auto" = attached by the server's BeatgridIndex.
 * Reload backfills may correct "auto" grids but never touch "manual" ones —
 * a grid with no source predates provenance and is treated as manual.
 */
export const BeatgridSourceEnum = z.enum(["auto", "manual"]);
export type BeatgridSourceType = z.infer<typeof BeatgridSourceEnum>;

export const AudioSourceSchema = z.object({
  url: z.string(),
  /** Present once beatgrid data is attached (curator import or server autoload). */
  beatgrid: BeatgridSchema.optional(),
  beatgridSource: BeatgridSourceEnum.optional(),
});
export type AudioSourceType = z.infer<typeof AudioSourceSchema>;

export const ChatMessageSchema = z.object({
  id: z.number(),
  clientId: z.string(),
  username: z.string(),
  text: z.string().max(CHAT_CONSTANTS.MAX_MESSAGE_LENGTH),
  timestamp: z.number(),
  countryCode: z.string().optional(),
  isCreator: z.boolean().default(false),
});
export type ChatMessageType = z.infer<typeof ChatMessageSchema>;
