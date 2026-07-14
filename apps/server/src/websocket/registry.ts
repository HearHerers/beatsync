import { ClientActionEnum } from "@beatsync/shared";
import { handleAudioSourceLoaded } from "@/websocket/handlers/handleAudioSourceLoaded";
import { handleDeleteAudioSources } from "@/websocket/handlers/handleDeleteAudioSources";
import { handleLoadDefaultTracks } from "@/websocket/handlers/handleLoadDefaultTracks";
import { handleSearchMusic } from "@/websocket/handlers/handleSearchMusic";
import { handleSendChatMessage } from "@/websocket/handlers/handleSendChatMessage";
import { handleSendIp } from "@/websocket/handlers/handleSendIp";
import { handleSetAdmin } from "@/websocket/handlers/handleSetAdmin";
import { handleSetPlaybackControls } from "@/websocket/handlers/handleSetPlaybackControls";
import { handleStreamMusic } from "@/websocket/handlers/handleStreamMusic";
import { handleMoveClient } from "@/websocket/handlers/moveClient";
import { handleNTPRequest } from "@/websocket/handlers/ntpRequest";
import { handlePause } from "@/websocket/handlers/pause";
import { handlePlay } from "@/websocket/handlers/play";
import { handleReorderClient } from "@/websocket/handlers/reorderClient";
import { handleSetGlobalVolume } from "@/websocket/handlers/setGlobalVolume";
import { handleSetListeningSource } from "@/websocket/handlers/setListeningSource";
import { handleStartSpatialAudio } from "@/websocket/handlers/startSpatialAudio";
import { handleStopSpatialAudio } from "@/websocket/handlers/stopSpatialAudio";
import { handleSetMetronome } from "@/websocket/handlers/setMetronome";
import { handleSetLowPassFreq } from "@/websocket/handlers/setLowPassFreq";
import { handleSetContextLoop } from "@/websocket/handlers/setContextLoop";
import {
  handleAddTrackToContext,
  handleImportTracksToContext,
  handleRemoveTrackFromContext,
  handleReorderTrackInContext,
} from "@/websocket/handlers/contextTracks";
import { handleSetRoomName } from "@/websocket/handlers/setRoomName";
import { handleSetUsername } from "@/websocket/handlers/setUsername";
import { handlePauseAllContexts } from "@/websocket/handlers/pauseAllContexts";
import { handlePlayAllContexts } from "@/websocket/handlers/playAllContexts";
import { handleSetTrackBeatgrid, handleSyncZones } from "@/websocket/handlers/zoneSync";
import { handleSync } from "@/websocket/handlers/sync";
import {
  handleAddShape,
  handleClearShapes,
  handleDeleteShape,
  handleSetDefaultTileLayer,
  handleSetGeoPosition,
  handleSetMapMetadata,
  handleSetShapeFalloff,
  handleSetShapeName,
  handleSetShapeGroup,
  handleSetVisibility,
  handleUpdateShape,
} from "@/websocket/handlers/mapHandlers";
import type { WebsocketRegistry } from "@/websocket/types";

export const WS_REGISTRY: WebsocketRegistry = {
  [ClientActionEnum.enum.AUDIO_SOURCE_LOADED]: {
    handle: handleAudioSourceLoaded,
    description: "Audio source loaded event",
  },
  [ClientActionEnum.enum.NTP_REQUEST]: {
    handle: handleNTPRequest,
    description: "Time synchronization request for NTP-based sync",
  },
  [ClientActionEnum.enum.PLAY]: {
    handle: handlePlay,
    description: "Schedule play action for synchronized playback",
  },

  [ClientActionEnum.enum.PAUSE]: {
    handle: handlePause,
    description: "Schedule pause action for synchronized playback",
  },

  [ClientActionEnum.enum.START_SPATIAL_AUDIO]: {
    handle: handleStartSpatialAudio,
    description: "Start spatial audio processing loop",
  },

  [ClientActionEnum.enum.STOP_SPATIAL_AUDIO]: {
    handle: handleStopSpatialAudio,
    description: "Stop spatial audio processing and reset gains",
  },

  [ClientActionEnum.enum.REORDER_CLIENT]: {
    handle: handleReorderClient,
    description: "Reorder clients in room for spatial positioning",
  },

  [ClientActionEnum.enum.SET_LISTENING_SOURCE]: {
    handle: handleSetListeningSource,
    description: "Update listening position for spatial audio",
  },

  [ClientActionEnum.enum.MOVE_CLIENT]: {
    handle: handleMoveClient,
    description: "Move client position in spatial audio space",
  },

  [ClientActionEnum.enum.SYNC]: {
    handle: handleSync,
    description: "Sync late-joining client with room state",
  },

  [ClientActionEnum.enum.LOAD_DEFAULT_TRACKS]: {
    handle: handleLoadDefaultTracks,
    description: "Load default tracks into the room if queue is empty",
  },

  [ClientActionEnum.enum.DELETE_AUDIO_SOURCES]: {
    handle: handleDeleteAudioSources,
    description: "Delete audio sources with room prefix (non-default only)",
  },

  [ClientActionEnum.enum.SET_ADMIN]: {
    handle: handleSetAdmin,
    description: "Set admin status for a client",
  },

  [ClientActionEnum.enum.SET_PLAYBACK_CONTROLS]: {
    handle: handleSetPlaybackControls,
    description: "Set playback controls for a room",
  },

  [ClientActionEnum.enum.SEND_IP]: {
    handle: handleSendIp,
    description: "Send IP to server",
  },

  [ClientActionEnum.enum.SEARCH_MUSIC]: {
    handle: handleSearchMusic,
    description: "Search for music",
  },

  [ClientActionEnum.enum.STREAM_MUSIC]: {
    handle: handleStreamMusic,
    description: "Stream music",
  },

  [ClientActionEnum.enum.SET_GLOBAL_VOLUME]: {
    handle: handleSetGlobalVolume,
    description: "Set global volume for all clients in the room",
  },

  [ClientActionEnum.enum.SEND_CHAT_MESSAGE]: {
    handle: handleSendChatMessage,
    description: "Send a chat message to all clients in the room",
  },
  [ClientActionEnum.enum.SET_METRONOME]: {
    handle: handleSetMetronome,
    description: "Toggle metronome on/off for all clients in the room",
  },
  [ClientActionEnum.enum.SET_LOW_PASS_FREQ]: {
    handle: handleSetLowPassFreq,
    description: "Set low-pass filter cutoff frequency for all clients",
  },
  [ClientActionEnum.enum.SET_CONTEXT_LOOP]: {
    handle: handleSetContextLoop,
    description: "Toggle the loop flag for a playlist context",
  },
  [ClientActionEnum.enum.SET_TRACK_BEATGRID]: {
    handle: handleSetTrackBeatgrid,
    description: "Attach imported beatgrid data to a track (by URL)",
  },
  [ClientActionEnum.enum.SYNC_ZONES]: {
    handle: handleSyncZones,
    description: "Beat-match a follower zone to a master zone",
  },
  [ClientActionEnum.enum.ADD_TRACK_TO_CONTEXT]: {
    handle: handleAddTrackToContext,
    description: "Append a track to a specific playlist context",
  },
  [ClientActionEnum.enum.REMOVE_TRACK_FROM_CONTEXT]: {
    handle: handleRemoveTrackFromContext,
    description: "Remove a track from a specific playlist context",
  },
  [ClientActionEnum.enum.REORDER_TRACK_IN_CONTEXT]: {
    handle: handleReorderTrackInContext,
    description: "Reorder the tracks within a specific playlist context",
  },
  [ClientActionEnum.enum.IMPORT_TRACKS_TO_CONTEXT]: {
    handle: handleImportTracksToContext,
    description: "Bulk-add tracks from an imported playlist file to a context",
  },
  [ClientActionEnum.enum.PLAY_ALL_CONTEXTS]: {
    handle: handlePlayAllContexts,
    description: "Start every eligible playlist context with one shared serverTimeToExecute",
  },
  [ClientActionEnum.enum.PAUSE_ALL_CONTEXTS]: {
    handle: handlePauseAllContexts,
    description: "Pause every currently-playing playlist context with one shared serverTimeToExecute",
  },

  // ── Map-room handlers ─────────────────────────────────────────────
  [ClientActionEnum.enum.ADD_SHAPE]: {
    handle: handleAddShape,
    description: "Add a new map zone (also creates its playlist context)",
  },
  [ClientActionEnum.enum.UPDATE_SHAPE]: {
    handle: handleUpdateShape,
    description: "Update a shape's geometry",
  },
  [ClientActionEnum.enum.DELETE_SHAPE]: {
    handle: handleDeleteShape,
    description: "Remove a shape (also removes its playlist context)",
  },
  [ClientActionEnum.enum.CLEAR_SHAPES]: {
    handle: handleClearShapes,
    description: "Remove every shape (and matching playlist context)",
  },
  [ClientActionEnum.enum.SET_SHAPE_FALLOFF]: {
    handle: handleSetShapeFalloff,
    description: "Set the edge-falloff distance (meters past the shape boundary at which gain hits 0)",
  },
  [ClientActionEnum.enum.SET_SHAPE_NAME]: {
    handle: handleSetShapeName,
    description: "Set or clear a shape's display name (empty = 'Zone <id>')",
  },
  [ClientActionEnum.enum.SET_SHAPE_GROUP]: {
    handle: handleSetShapeGroup,
    description: "Link/unlink a shape to a transport group",
  },
  [ClientActionEnum.enum.SET_MAP_METADATA]: {
    handle: handleSetMapMetadata,
    description: "Update the room's default Leaflet center/zoom",
  },
  [ClientActionEnum.enum.SET_ROOM_NAME]: {
    handle: handleSetRoomName,
    description: "Set or clear the room's display name (empty = use 'Room <id>')",
  },
  [ClientActionEnum.enum.SET_USERNAME]: {
    handle: handleSetUsername,
    description: "Update the caller's own display name",
  },
  [ClientActionEnum.enum.SET_DEFAULT_TILE_LAYER]: {
    handle: handleSetDefaultTileLayer,
    description: "Set the room-wide default base map / tile layer",
  },
  [ClientActionEnum.enum.SET_GEO_POSITION]: {
    handle: handleSetGeoPosition,
    description: "Update a client's GPS lat/lng",
  },
  [ClientActionEnum.enum.SET_VISIBILITY]: {
    handle: handleSetVisibility,
    description: "Update a client's tab-visibility state",
  },
};
