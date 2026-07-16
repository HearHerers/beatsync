"use client";
// Root shell for map rooms.
//
// Desktop layout — four horizontally-resizable panels; the center is a
// vertically-resizable Map/Playlist stack. Every panel is collapsible via
// its chevron/rail or the Users/Map/Playlist/Chat/Settings toggles rendered
// into the TopBar's status row. Settings starts collapsed.
//
//   ┌─ TopBar ────────── Users/Map/Playlist/Chat/Settings ─ socials ────┐
//   ├─────┬──────────────────────┬──────┬────────┐
//   │ Left│        Map           │ Right│Settings│  <- ResizableHandles
//   │users│ ─────────────────── ─│ chat │        │     between every
//   │     │      Playlist        │      │        │     adjacent pair
//   └─────┴──────────────────────┴──────┴────────┘
//
// Mobile layout — a top toolbar of five toggles (Users / Map / Playlist /
// Chat / Settings). Each toggle shows or hides its section in the vertical
// stack below; multiple expanded sections share the available height.
//
// All audio-room components (TopBar, Left, Right, Queue, AudioUploaderMinimal)
// are reused; the Queue + Uploader are parameterized by contextId == shape.id
// so the per-shape playlist GUI is identical to the audio-room playlist GUI.

import { Left } from "@/components/dashboard/Left";
import { Right } from "@/components/dashboard/Right";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { TopBar } from "@/components/room/TopBar";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SyncProgress } from "@/components/ui/SyncProgress";
import { useGeolocation } from "@/hooks/useGeolocation";
import { audioContextManager } from "@/lib/audioContextManager";
import { distanceToShapeEdgeMeters, proximityGainForShape } from "@/lib/geo";
import { mapAudio } from "@/lib/mapAudio";
import { hasSeenOnboarding } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum } from "@beatsync/shared";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ListMusic,
  Map as MapIcon,
  MapPin,
  MessageCircle,
  MousePointer,
  Settings,
  Users,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useDefaultLayout, useGroupRef, usePanelRef, type GroupImperativeHandle } from "react-resizable-panels";
import { EnsembleControls } from "./EnsembleControls";
import { MapCanvas, useCanMutate } from "./MapCanvas";
import { MapShapePanel } from "./MapShapePanel";
import { OnboardingWizard } from "./OnboardingWizard";

interface MapRoomProps {
  roomId: string;
}

// Shared handle for one desktop panel: the imperative resizable-panel ref plus
// a mirrored collapsed flag. Lifted into MapRoom so the TopBar toggles and
// DesktopLayout's chevrons/rails drive the same state.
interface PanelControl {
  ref: ReturnType<typeof usePanelRef>;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
}

const usePanelControl = (): PanelControl => {
  const ref = usePanelRef();
  const [collapsed, setCollapsed] = useState(false);
  return { ref, collapsed, setCollapsed };
};

interface DesktopPanels {
  users: PanelControl;
  map: PanelControl;
  playlist: PanelControl;
  chat: PanelControl;
  settings: PanelControl;
}

// ── Chat/Settings collapse+expand helpers ─────────────────────────────
// react-resizable-panels' imperative collapse()/expand() only trade space with
// the panel's pivot neighbor. Chat and Settings are pivot partners, which made
// them behave like an XOR: collapsing one handed its freed space to the other,
// force-expanding it even from a collapsed rail — and with both collapsed,
// expand() no-oped for Chat because its only neighbor (a collapsed rail) had
// no space to give. These helpers repair the layout afterwards via the group's
// setLayout so the space comes from / returns to the center panel instead.

// Panel ids in the horizontal group → their DesktopPanels key.
const SIDE_PANELS = { left: "users", right: "chat", settings: "settings" } as const;
type SidePanelId = keyof typeof SIDE_PANELS;

// Keep in sync with the ResizablePanel props in DesktopLayout.
const CENTER_MIN_PCT = 30;
const SIDE_MIN_PCT = 14;
const SIDE_EXPAND_PCT = 20;

function collapseSidePanel(group: GroupImperativeHandle | null, panels: DesktopPanels, id: SidePanelId) {
  const target = panels[SIDE_PANELS[id]];
  if (!group) {
    target.ref.current?.collapse();
    return;
  }
  const before = group.getLayout();
  target.ref.current?.collapse();
  const after = group.getLayout();
  // If the freed space landed on a sibling that was collapsed, put that
  // sibling back on its rail and give the space to center.
  const fixed = { ...after };
  let reclaimed = 0;
  for (const [panelId, key] of Object.entries(SIDE_PANELS) as [SidePanelId, keyof DesktopPanels][]) {
    if (panelId === id) continue;
    const grew = (after[panelId] ?? 0) - (before[panelId] ?? 0);
    if (panels[key].collapsed && grew > 0.1) {
      reclaimed += grew;
      fixed[panelId] = before[panelId] ?? 0;
    }
  }
  if (reclaimed > 0.1) {
    fixed.center = (fixed.center ?? 0) + reclaimed;
    group.setLayout(fixed);
  }
}

function expandSidePanel(group: GroupImperativeHandle | null, panels: DesktopPanels, id: SidePanelId) {
  const ref = panels[SIDE_PANELS[id]].ref.current;
  ref?.expand();
  if (!group || !ref || !ref.isCollapsed()) return;
  // expand() no-oped because the pivot neighbor is a collapsed rail; take the
  // space from center instead.
  const layout = group.getLayout();
  const current = layout[id] ?? 0;
  const grow = Math.min(SIDE_EXPAND_PCT - current, (layout.center ?? 0) - CENTER_MIN_PCT);
  if (current + grow < SIDE_MIN_PCT) return;
  group.setLayout({ ...layout, [id]: current + grow, center: (layout.center ?? 0) - grow });
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

  const desktopPanels: DesktopPanels = {
    users: usePanelControl(),
    map: usePanelControl(),
    playlist: usePanelControl(),
    chat: usePanelControl(),
    settings: usePanelControl(),
  };
  // Handle for the horizontal panel group — needed by the side-panel helpers
  // to fix up layouts after collapse/expand (see collapseSidePanel above).
  const horizontalGroupRef = useGroupRef();

  // Desktop panel toggles — rendered inside the TopBar's status row. Same
  // on/off affordance as the mobile toolbar, driving the same panel refs as
  // the collapse chevrons/rails. Ref access stays inside the inline onClick
  // handlers (the react-compiler lint rule rejects refs captured in closures
  // built during render).
  const panelControls = (
    <div className="hidden lg:flex items-center gap-1">
      {(
        [
          { label: "Users", icon: <Users className="size-3" />, panel: desktopPanels.users, sideId: "left" },
          { label: "Map", icon: <MapIcon className="size-3" />, panel: desktopPanels.map },
          { label: "Playlist", icon: <ListMusic className="size-3" />, panel: desktopPanels.playlist },
          { label: "Chat", icon: <MessageCircle className="size-3" />, panel: desktopPanels.chat, sideId: "right" },
          {
            label: "Settings",
            icon: <Settings className="size-3" />,
            panel: desktopPanels.settings,
            sideId: "settings",
          },
        ] as Array<{ label: string; icon: React.ReactNode; panel: PanelControl; sideId?: SidePanelId }>
      ).map(({ label, icon, panel, sideId }) => (
        <Button
          key={label}
          size="sm"
          variant={panel.collapsed ? "outline" : "default"}
          className="h-6 px-2 text-[11px]"
          onClick={() => {
            const isCollapsed = panel.ref.current?.isCollapsed() ?? false;
            if (sideId) {
              // Side panels route through the helpers so Chat and Settings
              // don't trade space with each other's collapsed rails.
              if (isCollapsed) expandSidePanel(horizontalGroupRef.current, desktopPanels, sideId);
              else collapseSidePanel(horizontalGroupRef.current, desktopPanels, sideId);
            } else if (isCollapsed) {
              panel.ref.current?.expand();
            } else {
              panel.ref.current?.collapse();
            }
          }}
          title={`${panel.collapsed ? "Show" : "Hide"} ${label}`}
        >
          <span className="mr-1">{icon}</span>
          {label}
        </Button>
      ))}
    </div>
  );

  // First-visit onboarding wizard (#80). queueMicrotask defers the React state
  // out of the effect body (avoids the set-state-in-effect lint); localStorage
  // is client-only so this can only run after mount anyway.
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setShowOnboarding(!hasSeenOnboarding(roomId)));
  }, [roomId]);

  const overlays = (
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
  );

  return (
    <div className="flex h-dvh w-full flex-col bg-neutral-950 text-white">
      {showOnboarding && <OnboardingWizard roomId={roomId} onDone={() => setShowOnboarding(false)} />}

      <TopBar roomId={roomId} panelControls={isReady ? panelControls : undefined} />

      {!isSynced && hasUserStartedSystem && !isLoadingAudio && <SyncProgress />}

      {isReady && (
        <motion.div
          className="flex flex-1 flex-col overflow-hidden min-h-0"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {/* Desktop / wide layout — resizable + collapsible. */}
          <div className="hidden lg:flex lg:flex-1 lg:overflow-hidden min-h-0">
            <DesktopLayout
              canMutate={canMutate}
              overlays={overlays}
              panels={desktopPanels}
              groupRef={horizontalGroupRef}
            />
          </div>

          {/* Mobile / narrow layout — toggleable panels, no resizing. */}
          <div className="flex flex-1 flex-col overflow-hidden lg:hidden min-h-0">
            <MobileLayout canMutate={canMutate} overlays={overlays} />
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

// ── Desktop layout ────────────────────────────────────────────────────
// Four horizontally-resizable panels: Left (users) | center | Chat | Settings.
// Center is a vertically-resizable Map/Playlist stack. Each panel is
// collapsible to a thin rail showing only an expand icon. Sizes persist
// across reloads via react-resizable-panels' autoSaveId.
interface PaneProps {
  canMutate: boolean;
  overlays: React.ReactNode;
}

interface DesktopLayoutProps extends PaneProps {
  panels: DesktopPanels;
  groupRef: ReturnType<typeof useGroupRef>;
}

const DesktopLayout = ({ canMutate, overlays, panels, groupRef }: DesktopLayoutProps) => {
  const { ref: leftRef, collapsed: leftCollapsed, setCollapsed: setLeftCollapsed } = panels.users;
  const { ref: mapRef, collapsed: mapCollapsed, setCollapsed: setMapCollapsed } = panels.map;
  const { ref: playlistRef, collapsed: playlistCollapsed, setCollapsed: setPlaylistCollapsed } = panels.playlist;
  const { ref: rightRef, collapsed: rightCollapsed, setCollapsed: setRightCollapsed } = panels.chat;
  const { ref: settingsRef, collapsed: settingsCollapsed, setCollapsed: setSettingsCollapsed } = panels.settings;

  // Layout persistence — survives page reloads via localStorage. The id is
  // versioned: bump it whenever the panel list changes so a stale persisted
  // layout can't be applied to a different set of panels.
  const horizontal = useDefaultLayout({
    id: "mapRoom.horizontal.v2",
    panelIds: ["left", "center", "right", "settings"],
  });
  const vertical = useDefaultLayout({
    id: "mapRoom.vertical",
    panelIds: ["map", "playlist"],
  });

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      groupRef={groupRef}
      defaultLayout={horizontal.defaultLayout}
      onLayoutChanged={horizontal.onLayoutChanged}
    >
      <ResizablePanel
        id="left"
        panelRef={leftRef}
        collapsible
        collapsedSize="40px"
        minSize="14%"
        defaultSize="20%"
        onResize={() => setLeftCollapsed(leftRef.current?.isCollapsed() ?? false)}
      >
        {leftCollapsed ? (
          <CollapsedRail
            label="Users"
            icon={<Users className="size-3.5" />}
            onClick={() => leftRef.current?.expand()}
            side="left"
          />
        ) : (
          <PanelShell
            label="Users"
            icon={<Users className="size-3.5" />}
            onCollapse={() => leftRef.current?.collapse()}
            side="left"
          >
            <Left className="flex h-full w-full lg:w-full" hideUploader hideDelayControl roomLabel="HearHere room" />
          </PanelShell>
        )}
      </ResizablePanel>

      <ResizableHandle orientation="horizontal" withHandle />

      <ResizablePanel id="center" minSize="30%" defaultSize="55%">
        <ResizablePanelGroup
          orientation="vertical"
          defaultLayout={vertical.defaultLayout}
          onLayoutChanged={vertical.onLayoutChanged}
        >
          <ResizablePanel
            id="map"
            panelRef={mapRef}
            collapsible
            collapsedSize="32px"
            minSize="20%"
            defaultSize="65%"
            onResize={() => setMapCollapsed(mapRef.current?.isCollapsed() ?? false)}
          >
            {mapCollapsed ? (
              <CollapsedRail
                label="Map"
                icon={<MapIcon className="size-3.5" />}
                onClick={() => mapRef.current?.expand()}
                side="top"
              />
            ) : (
              <div className="relative h-full">
                {overlays}
                <MapCanvas canMutate={canMutate} />
                <CollapseButton onClick={() => mapRef.current?.collapse()} side="top" />
              </div>
            )}
          </ResizablePanel>

          <ResizableHandle orientation="vertical" withHandle />

          <ResizablePanel
            id="playlist"
            panelRef={playlistRef}
            collapsible
            collapsedSize="32px"
            minSize="15%"
            defaultSize="35%"
            onResize={() => setPlaylistCollapsed(playlistRef.current?.isCollapsed() ?? false)}
          >
            {playlistCollapsed ? (
              <CollapsedRail
                label="Playlist"
                icon={<ListMusic className="size-3.5" />}
                onClick={() => playlistRef.current?.expand()}
                side="bottom"
              />
            ) : (
              <PanelShell
                label="Playlist"
                icon={<ListMusic className="size-3.5" />}
                onCollapse={() => playlistRef.current?.collapse()}
                side="bottom"
                className="flex h-full flex-col bg-neutral-900/30"
              >
                <MapShapePanel canMutate={canMutate} />
              </PanelShell>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>

      <ResizableHandle orientation="horizontal" withHandle />

      <ResizablePanel
        id="right"
        panelRef={rightRef}
        collapsible
        collapsedSize="40px"
        minSize="14%"
        defaultSize="20%"
        onResize={() => setRightCollapsed(rightRef.current?.isCollapsed() ?? false)}
      >
        {rightCollapsed ? (
          <CollapsedRail
            label="Chat"
            icon={<MessageCircle className="size-3.5" />}
            onClick={() => expandSidePanel(groupRef.current, panels, "right")}
            side="right"
          />
        ) : (
          <PanelShell
            label="Chat"
            icon={<MessageCircle className="size-3.5" />}
            onCollapse={() => collapseSidePanel(groupRef.current, panels, "right")}
            side="right"
          >
            <Right chatOnly className="w-full lg:w-full border-l-0" />
          </PanelShell>
        )}
      </ResizablePanel>

      <ResizableHandle orientation="horizontal" withHandle />

      {/* Settings — starts collapsed (defaultSize == collapsedSize); expand via
          the rail, or the TopBar toggle. */}
      <ResizablePanel
        id="settings"
        panelRef={settingsRef}
        collapsible
        collapsedSize="40px"
        minSize="14%"
        defaultSize="40px"
        onResize={() => setSettingsCollapsed(settingsRef.current?.isCollapsed() ?? false)}
      >
        {settingsCollapsed ? (
          <CollapsedRail
            label="Settings"
            icon={<Settings className="size-3.5" />}
            onClick={() => expandSidePanel(groupRef.current, panels, "settings")}
            side="right"
          />
        ) : (
          <PanelShell
            label="Settings"
            icon={<Settings className="size-3.5" />}
            onCollapse={() => collapseSidePanel(groupRef.current, panels, "settings")}
            side="right"
          >
            <SettingsPanel className="h-full" />
          </PanelShell>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};

// ── Mobile layout ─────────────────────────────────────────────────────
// Top toolbar of four toggles. Each visible section flex-1's into the
// available space below. Map + Playlist are shown by default; Users + Chat
// are hidden by default to keep the limited mobile real estate focused.
const MobileLayout = ({ canMutate, overlays }: PaneProps) => {
  const [usersOpen, setUsersOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(true);
  const [playlistOpen, setPlaylistOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const toggles: Array<{
    label: string;
    icon: React.ReactNode;
    open: boolean;
    setOpen: (v: boolean) => void;
  }> = [
    { label: "Users", icon: <Users className="size-3.5" />, open: usersOpen, setOpen: setUsersOpen },
    { label: "Map", icon: <MapIcon className="size-3.5" />, open: mapOpen, setOpen: setMapOpen },
    { label: "Playlist", icon: <ListMusic className="size-3.5" />, open: playlistOpen, setOpen: setPlaylistOpen },
    { label: "Chat", icon: <MessageCircle className="size-3.5" />, open: chatOpen, setOpen: setChatOpen },
    { label: "Settings", icon: <Settings className="size-3.5" />, open: settingsOpen, setOpen: setSettingsOpen },
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex flex-shrink-0 gap-1 border-b border-neutral-800/50 bg-neutral-900/40 px-2 py-1.5">
        {toggles.map(({ label, icon, open, setOpen }) => (
          <Button
            key={label}
            size="sm"
            variant={open ? "default" : "outline"}
            className="h-7 flex-1 px-1.5 text-[11px]"
            onClick={() => setOpen(!open)}
            title={label}
          >
            <span className="max-[480px]:mr-0 mr-1">{icon}</span>
            <span className="max-[480px]:hidden">{label}</span>
          </Button>
        ))}
      </div>

      <div className="flex flex-1 flex-col overflow-hidden min-h-0">
        {usersOpen && (
          <div className="flex-1 min-h-0 overflow-hidden border-b border-neutral-800/50">
            <Left className="flex h-full w-full lg:w-full border-l-0" hideUploader roomLabel="HearHere room" />
          </div>
        )}
        {mapOpen && (
          <div className="relative flex-1 min-h-0">
            {overlays}
            <MapCanvas canMutate={canMutate} />
          </div>
        )}
        {playlistOpen && (
          <div className="flex flex-1 min-h-0 flex-col border-t border-neutral-800/50 bg-neutral-900/40">
            <MapShapePanel canMutate={canMutate} />
          </div>
        )}
        {chatOpen && (
          <div className="flex-1 min-h-0 overflow-hidden border-t border-neutral-800/50">
            <Right chatOnly />
          </div>
        )}
        {settingsOpen && (
          <div className="flex-1 min-h-0 overflow-hidden border-t border-neutral-800/50">
            <SettingsPanel className="h-full" />
          </div>
        )}
      </div>
    </div>
  );
};

// ── Panel shell ──────────────────────────────────────────────────────
// Wraps a panel's content with a slim 24px header bar (icon + label, plus a
// collapse chevron at the inner edge). The header lives above the panel
// content rather than overlapping it, which avoids conflicts with the
// existing top-row controls in Left/Right/MapShapePanel (QR button, Chat
// icon, Loop/Delete buttons).
const PanelShell = ({
  children,
  onCollapse,
  side,
  label,
  icon,
  className,
}: {
  children: React.ReactNode;
  onCollapse: () => void;
  /** Side the panel sits on relative to the resize handle — drives chevron
   *  direction (point in the collapse direction) and which end of the header
   *  bar the chevron renders. */
  side: "left" | "right" | "top" | "bottom";
  label: string;
  icon: React.ReactNode;
  className?: string;
}) => {
  const ChevIcon =
    side === "left" ? ChevronLeft : side === "right" ? ChevronRight : side === "top" ? ChevronUp : ChevronDown;
  // For "right" panel the resize handle is on the LEFT, so the chevron goes
  // on the left end of the header (points right → towards collapse). For
  // every other side the chevron sits at the right end of the header.
  const chevronAtStart = side === "right";

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex h-6 flex-shrink-0 items-center justify-between border-b border-neutral-800/50 bg-neutral-900/40 px-1.5 text-[11px]">
        {chevronAtStart && (
          <CollapseChevron icon={<ChevIcon className="size-3" />} onClick={onCollapse} label={label} />
        )}
        <div className="flex flex-1 items-center gap-1.5 px-1 text-neutral-300">
          {icon}
          <span className="font-medium">{label}</span>
        </div>
        {!chevronAtStart && (
          <CollapseChevron icon={<ChevIcon className="size-3" />} onClick={onCollapse} label={label} />
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
};

const CollapseChevron = ({ icon, onClick, label }: { icon: React.ReactNode; onClick: () => void; label: string }) => (
  <button
    type="button"
    onClick={onClick}
    title={`Collapse ${label}`}
    className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
  >
    {icon}
  </button>
);

// Floating chevron button used by the Map panel only — the leaflet canvas
// has no header bar, so the chevron floats in the top-right corner alongside
// the location-mode buttons.
const CollapseButton = ({ onClick, side }: { onClick: () => void; side: "left" | "right" | "top" | "bottom" }) => {
  const Icon =
    side === "left" ? ChevronLeft : side === "right" ? ChevronRight : side === "top" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Collapse panel"
      className={cn(
        "absolute z-[1100] flex h-5 w-5 items-center justify-center rounded border border-neutral-700 bg-neutral-900/90 text-neutral-300 shadow hover:bg-neutral-800",
        side === "left" && "top-2 right-2",
        side === "right" && "top-2 left-2",
        side === "top" && "top-2 right-2",
        side === "bottom" && "top-2 right-2"
      )}
    >
      <Icon className="size-3" />
    </button>
  );
};

// Rail rendered in place of a collapsed panel. The whole rail is one big
// click target that expands the panel. Styled bright enough to read against
// the surrounding bg-neutral-950 so the user can actually find it.
const CollapsedRail = ({
  label,
  icon,
  onClick,
  side,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  side: "left" | "right" | "top" | "bottom";
}) => {
  const Icon =
    side === "left" ? ChevronRight : side === "right" ? ChevronLeft : side === "top" ? ChevronDown : ChevronUp;
  const isVertical = side === "left" || side === "right";

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Expand ${label}`}
      className={cn(
        "group flex h-full w-full items-center justify-center gap-2 bg-neutral-800 text-[11px] font-semibold uppercase tracking-wider text-neutral-200 transition-colors hover:bg-indigo-600 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400",
        isVertical && "flex-col py-3",
        side === "left" && "border-r-2 border-indigo-500/70",
        side === "right" && "border-l-2 border-indigo-500/70",
        side === "top" && "border-b-2 border-indigo-500/70",
        side === "bottom" && "border-t-2 border-indigo-500/70"
      )}
    >
      <span className={cn("flex items-center gap-1.5", isVertical && "flex-col")}>
        <span className="flex h-6 w-6 items-center justify-center rounded bg-neutral-900 text-indigo-300 group-hover:bg-indigo-700 group-hover:text-white">
          <Icon className="size-3.5" />
        </span>
        <span className={cn(isVertical && "[writing-mode:vertical-rl] [text-orientation:mixed]")}>{label}</span>
        <span className="opacity-70">{icon}</span>
      </span>
    </button>
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
    {/* Top-right location controls — nudged left so they don't overlap the collapse chevron */}
    <div className="absolute top-2 right-10 z-[1000] flex gap-1">
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
