"use client";
// Root shell for map rooms. Mirrors the audio-room Dashboard layout:
//
//   ┌─ TopBar ───────────────────────────────────────────────────┐
//   │                                                            │
//   ├──────┬──────────────────────┬─────────────────┬────────────┤
//   │ Left │       Map            │  Shape playlist │  Right     │
//   │users │                      │  (Queue + Upload)│ (chat)    │
//   ├──────┴──────────────────────┴─────────────────┴────────────┤
//   │ Bottom: ensemble Play All / Pause All                      │
//   └────────────────────────────────────────────────────────────┘
//
// All audio-room components (TopBar, Left, Right, Queue, AudioUploaderMinimal)
// are reused; the Queue + Uploader are parameterized by contextId == shape.id
// so the per-shape playlist GUI is identical to the audio-room playlist GUI.

import { Left } from "@/components/dashboard/Left";
import { Right } from "@/components/dashboard/Right";
import { TopBar } from "@/components/room/TopBar";
import { Button } from "@/components/ui/button";
import { SyncProgress } from "@/components/ui/SyncProgress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGeolocation } from "@/hooks/useGeolocation";
import { audioContextManager } from "@/lib/audioContextManager";
import { distanceToShapeEdgeMeters, proximityGainForShape } from "@/lib/geo";
import { mapAudio } from "@/lib/mapAudio";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum } from "@beatsync/shared";
import { ListMusic, MapPin, MapPinned, MessageCircle, MousePointer, Users } from "lucide-react";
import { motion } from "motion/react";
import { useEffect } from "react";
import { EnsembleControls } from "./EnsembleControls";
import { MapCanvas, useCanMutate } from "./MapCanvas";
import { MapShapePanel } from "./MapShapePanel";

interface MapRoomProps {
  roomId: string;
}

export const MapRoom = ({ roomId }: MapRoomProps) => {
  const isSynced = useGlobalStore((s) => s.isSynced);
  const isLoadingAudio = useGlobalStore((s) => s.isInitingSystem);
  const hasUserStartedSystem = useGlobalStore((s) => s.hasUserStartedSystem);
  const canMutate = useCanMutate();
  const locationMode = useMapStore((s) => s.locationMode);
  const setLocationMode = useMapStore((s) => s.setLocationMode);
  const ownPosition = useMapStore((s) => s.ownPosition);
  const setOwnPosition = useMapStore((s) => s.setOwnPosition);
  const shapes = useMapStore((s) => s.shapes);
  // Subscribed so the range-cull effect re-runs when the server's per-shape
  // playback state changes (e.g. someone hits play in another zone while
  // we're standing still).
  const playlists = useGlobalStore((s) => s.playlists);

  const {
    latitude,
    longitude,
    accuracy,
    error: gpsError,
    isWatching,
    isSupported,
    startWatching,
    stopWatching,
  } = useGeolocation({ enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });

  // Start/stop GPS watching based on locationMode.
  useEffect(() => {
    if (locationMode === "gps") startWatching();
    else stopWatching();
  }, [locationMode, startWatching, stopWatching]);

  // GPS → store + server.
  useEffect(() => {
    if (locationMode !== "gps") return;
    if (latitude == null || longitude == null) return;
    setOwnPosition({ lat: latitude, lng: longitude });
    const ws = useGlobalStore.getState().socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWSRequest({
        ws,
        request: { type: ClientActionEnum.enum.SET_GEO_POSITION, lat: latitude, lng: longitude },
      });
    }
  }, [locationMode, latitude, longitude, setOwnPosition]);

  // Compute + apply proximity gains whenever own position or shape geometry changes.
  // Also range-culls local playback: when the listener is far enough past a
  // zone's edge that they can't hear it anyway, we tear down the source node
  // instead of leaving it running at gain 0 (saves CPU + memory, especially
  // important when many zones are configured). When the listener re-enters
  // the audible range, we re-fire mapAudio.playShape using the server's
  // per-shape playbackState so timing stays in sync without a server roundtrip.
  useEffect(() => {
    if (!ownPosition) return;
    const nextGains = new Map<string, number>();
    for (const shape of shapes.values()) {
      const gain = proximityGainForShape(ownPosition, shape);
      nextGains.set(shape.id, gain);
      mapAudio.setProximityGain(shape.id, gain);

      // Range cull: 3× past the falloff = fully out of earshot. Pause locally
      // (server stays "playing" for everyone else). Inside this threshold, if
      // the server says we should be playing and we're not, resume.
      const distance = distanceToShapeEdgeMeters(ownPosition, shape);
      const cullDistance = Math.max(shape.falloffMeters * 3, 50);
      const inRange = distance <= cullDistance;
      const serverPlayback = playlists.get(shape.id)?.playbackState;
      const serverIsPlaying = serverPlayback?.type === "playing" && !!serverPlayback.audioSource;
      const locallyPlaying = mapAudio.isShapePlaying(shape.id);

      if (!inRange && locallyPlaying) {
        mapAudio.pauseShape(shape.id);
      } else if (inRange && serverIsPlaying && !locallyPlaying && serverPlayback) {
        mapAudio.playShape(
          shape.id,
          serverPlayback.audioSource,
          serverPlayback.trackPositionSeconds,
          serverPlayback.serverTimeToExecute
        );
      }
    }
    useMapStore.getState().setProximityGains(nextGains);
  }, [ownPosition, shapes, playlists]);

  // Tear down audio chains for shapes that have been deleted. Without this,
  // mapAudio's chain map keeps the AudioBufferSourceNode running even after
  // the server removed the shape (and its playlist context) — so a deleted
  // zone would keep playing at whatever gain it had at the moment of deletion.
  useEffect(() => {
    const liveIds = new Set(shapes.keys());
    for (const knownId of mapAudio.knownShapeIds()) {
      if (!liveIds.has(knownId)) mapAudio.unloadShape(knownId);
    }
  }, [shapes]);

  // Autoplay-policy unlock: browsers keep the AudioContext suspended until a real
  // user gesture. A late-joining map-room visitor receives a unicast resume from
  // the server *before* any interaction — so source.start() schedules silently.
  // Listen for the first pointer/keyboard event and resume the context.
  useEffect(() => {
    const events = ["pointerdown", "touchend", "keydown"] as const;
    const tryResume = () => {
      void audioContextManager.resume().then(() => {
        for (const evt of events) window.removeEventListener(evt, tryResume, true);
      });
    };
    for (const evt of events) {
      window.addEventListener(evt, tryResume, { capture: true, passive: true });
    }
    return () => {
      for (const evt of events) window.removeEventListener(evt, tryResume, true);
    };
  }, []);

  const isReady = isSynced && !isLoadingAudio;
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: 0.5, staggerChildren: 0.1 } },
  };

  return (
    <div className="flex h-dvh w-full flex-col bg-neutral-950 text-white">
      <TopBar roomId={roomId} />

      {!isSynced && hasUserStartedSystem && !isLoadingAudio && <SyncProgress />}

      {isReady && (
        <motion.div
          className="flex flex-1 flex-col overflow-hidden min-h-0"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {/* Desktop / wide layout — Left | (Map stacked over Playlist) | Right */}
          <div className="hidden lg:flex lg:flex-1 lg:overflow-hidden min-h-0">
            <Left className="flex" hideUploader roomLabel="HereHear room" />

            <div className="flex flex-1 flex-col min-w-0 min-h-0">
              <div className="relative flex-[2] min-h-0">
                <MapOverlays
                  locationMode={locationMode}
                  setLocationMode={setLocationMode}
                  isSupported={isSupported}
                  isWatching={isWatching}
                  latitude={latitude}
                  longitude={longitude}
                  accuracy={accuracy}
                  gpsError={gpsError}
                  ownPosition={ownPosition}
                />
                <MapCanvas canMutate={canMutate} />
              </div>
              <div className="flex flex-[1] min-h-0 flex-col border-t border-neutral-800/50 bg-neutral-900/30">
                <MapShapePanel canMutate={canMutate} />
              </div>
            </div>

            <Right chatOnly />
          </div>

          {/* Mobile / narrow layout — Map / Zone / Chat / Menu in a tab bar so
              the chat + connected-users + audio-output controls (which the
              desktop layout puts in the side rails) are reachable on narrow
              viewports. */}
          <div className="flex flex-1 flex-col overflow-hidden lg:hidden min-h-0">
            <Tabs defaultValue="map" className="flex-1 flex flex-col overflow-hidden min-h-0">
              <TabsList className="shrink-0 grid w-full grid-cols-4 h-11 rounded-none p-0 bg-neutral-950/90">
                <TabsTrigger
                  value="map"
                  className="rounded-none text-xs gap-1 h-full text-neutral-400 data-[state=active]:text-white data-[state=active]:bg-white/5 transition-colors"
                >
                  <MapPinned className="h-3.5 w-3.5" /> Map
                </TabsTrigger>
                <TabsTrigger
                  value="zone"
                  className="rounded-none text-xs gap-1 h-full text-neutral-400 data-[state=active]:text-white data-[state=active]:bg-white/5 transition-colors"
                >
                  <ListMusic className="h-3.5 w-3.5" /> Zone
                </TabsTrigger>
                <TabsTrigger
                  value="chat"
                  className="rounded-none text-xs gap-1 h-full text-neutral-400 data-[state=active]:text-white data-[state=active]:bg-white/5 transition-colors"
                >
                  <MessageCircle className="h-3.5 w-3.5" /> Chat
                </TabsTrigger>
                <TabsTrigger
                  value="menu"
                  className="rounded-none text-xs gap-1 h-full text-neutral-400 data-[state=active]:text-white data-[state=active]:bg-white/5 transition-colors"
                >
                  <Users className="h-3.5 w-3.5" /> Menu
                </TabsTrigger>
              </TabsList>

              {/* MAP tab — full-bleed map with the overlay controls. */}
              <TabsContent value="map" className="flex-1 mt-0 min-h-0 relative">
                <MapOverlays
                  locationMode={locationMode}
                  setLocationMode={setLocationMode}
                  isSupported={isSupported}
                  isWatching={isWatching}
                  latitude={latitude}
                  longitude={longitude}
                  accuracy={accuracy}
                  gpsError={gpsError}
                  ownPosition={ownPosition}
                />
                <MapCanvas canMutate={canMutate} />
              </TabsContent>

              {/* ZONE tab — the selected-shape playlist (the right column of
                  the desktop layout). */}
              <TabsContent value="zone" className="flex-1 mt-0 min-h-0">
                <MapShapePanel canMutate={canMutate} />
              </TabsContent>

              {/* CHAT tab — full-height chat panel. */}
              <TabsContent value="chat" className="flex-1 mt-0 min-h-0 overflow-hidden">
                <Right chatOnly />
              </TabsContent>

              {/* MENU tab — connected users + audio output + room QR. Reuses
                  the existing Left sidebar wholesale; hideUploader keeps the
                  audio uploader out of map rooms (it lives per-shape in the
                  Zone tab's playlist). */}
              <TabsContent value="menu" className="flex-1 mt-0 min-h-0 overflow-y-auto">
                <Left className="flex h-full w-full" hideUploader roomLabel="HereHear room" />
              </TabsContent>
            </Tabs>
          </div>

          {/* Bottom: ensemble play/pause for the whole installation. */}
          <div className="flex-shrink-0 border-t border-neutral-800/50 bg-neutral-900/40 px-4 py-3 backdrop-blur">
            <EnsembleControls />
          </div>
        </motion.div>
      )}
    </div>
  );
};

// ── Map overlays ──────────────────────────────────────────────────────
// Top-right location-mode buttons + GPS/manual feedback indicators. Kept as a
// helper here so the layout above stays readable; they sit on top of the
// Leaflet canvas using absolute positioning.
interface MapOverlaysProps {
  locationMode: "manual" | "gps";
  setLocationMode: (m: "manual" | "gps") => void;
  isSupported: boolean;
  isWatching: boolean;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  gpsError: string | null;
  ownPosition?: { lat: number; lng: number };
}

const MapOverlays = ({
  locationMode,
  setLocationMode,
  isSupported,
  isWatching,
  latitude,
  longitude,
  accuracy,
  gpsError,
  ownPosition,
}: MapOverlaysProps) => (
  <>
    {/* Top-right location controls */}
    <div className="absolute top-2 right-2 z-[1000] flex gap-1">
      <Button
        size="sm"
        variant={locationMode === "manual" ? "default" : "outline"}
        className="h-7 px-2 text-[11px]"
        onClick={() => setLocationMode("manual")}
      >
        <MousePointer className="mr-1 size-3" /> Manual
      </Button>
      <Button
        size="sm"
        variant={locationMode === "gps" ? "default" : "outline"}
        className="h-7 px-2 text-[11px]"
        onClick={() => setLocationMode("gps")}
        disabled={!isSupported}
      >
        <MapPin className="mr-1 size-3" /> GPS
      </Button>
    </div>

    {locationMode === "gps" && (
      <div className="absolute bottom-2 right-2 z-[1000] rounded border border-neutral-800 bg-neutral-950/85 px-3 py-1.5 text-[11px] shadow backdrop-blur">
        {gpsError ? (
          <span className="text-red-400">⚠️ {gpsError}</span>
        ) : isWatching && latitude != null && longitude != null ? (
          <>
            <div>
              {latitude.toFixed(6)}, {longitude.toFixed(6)}
            </div>
            {accuracy != null && <div className="text-neutral-500">±{accuracy.toFixed(0)}m</div>}
          </>
        ) : (
          <span>Acquiring GPS…</span>
        )}
      </div>
    )}

    {locationMode === "manual" && !ownPosition && (
      <div className="absolute bottom-2 left-1/2 z-[1000] -translate-x-1/2 rounded border border-neutral-800 bg-neutral-950/90 px-3 py-1.5 text-[11px] text-neutral-300 shadow">
        Click the map to set your position.
      </div>
    )}
  </>
);
