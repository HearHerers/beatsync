"use client";
import { generateName } from "@/lib/randomNames";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { hasConfirmedUsername, loadSavedUsername, markUsernameConfirmed } from "@/lib/username";
import { useRoomStore } from "@/store/room";
import type { RoomTypeValue } from "@beatsync/shared";
import { motion } from "motion/react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { IS_DEMO_MODE } from "@/lib/demo";
import { Dashboard } from "./dashboard/Dashboard";
import { DemoDashboard } from "./dashboard/DemoDashboard";
import { RoomJoinGate } from "./room/RoomJoinGate";
import { WebSocketManager } from "./room/WebSocketManager";

// Leaflet is browser-only — dynamic-import the map shell with ssr:false to keep Next's
// SSR pipeline happy. The chunk only loads in map rooms, so audio rooms pay no cost.
const MapRoom = dynamic(() => import("./map/MapRoom").then((m) => m.MapRoom), {
  ssr: false,
  loading: () => <div className="flex h-screen items-center justify-center text-sm text-neutral-400">Loading map…</div>,
});

interface NewSyncerProps {
  roomId: string;
  /** Which room type the URL asked for. The server's ROOM_TYPE_INFO has final say. */
  requestedRoomType?: RoomTypeValue;
}

export const NewSyncer = ({ roomId, requestedRoomType }: NewSyncerProps) => {
  const setUsername = useRoomStore((state) => state.setUsername);
  const setRoomId = useRoomStore((state) => state.setRoomId);
  const setRequestedRoomType = useRoomStore((state) => state.setRequestedRoomType);
  const username = useRoomStore((state) => state.username);
  const roomType = useRoomStore((state) => state.roomType);

  // Update document title based on playback state
  useDocumentTitle();

  // Whether we've checked localStorage yet, and whether we still need to prompt
  // for a name (#68). null until checked so we don't flash the room or the gate.
  const [needsName, setNeedsName] = useState<boolean | null>(null);

  // Seed the username (saved name → else a random suggestion) and decide whether
  // to show the join gate. Store writes are fine in the effect body; React state
  // is deferred via queueMicrotask to avoid the set-state-in-effect lint.
  useEffect(() => {
    setRoomId(roomId);
    setRequestedRoomType(requestedRoomType);
    if (!username) {
      setUsername(loadSavedUsername() ?? generateName());
    }
    queueMicrotask(() => setNeedsName(!hasConfirmedUsername()));
  }, [setUsername, username, roomId, setRoomId, requestedRoomType, setRequestedRoomType]);

  // Until ROOM_TYPE_INFO arrives, render the "most likely" UI based on the URL's
  // requested type so visitors don't see a flash of the wrong dashboard.
  const effectiveRoomType: RoomTypeValue = roomType ?? requestedRoomType ?? "audio";

  // Keep the address bar canonical: once the server confirms the room's type,
  // rewrite a mismatched URL prefix (e.g. joined a map room via /room/{id}) so
  // refreshes and shared links land on the right route. history.replaceState
  // instead of router.replace — a router navigation would remount the tree and
  // drop the WebSocket connection.
  useEffect(() => {
    if (!roomType) return;
    const canonicalPath = `/${roomType === "map" ? "map" : "room"}/${roomId}`;
    if (window.location.pathname !== canonicalPath) {
      window.history.replaceState(null, "", canonicalPath);
    }
  }, [roomType, roomId]);

  // Still checking localStorage — render nothing to avoid a flash of either UI.
  if (needsName === null) return null;

  // First join via a shared link (no confirmed name yet): prompt before connecting
  // so the server gets the chosen name from the start.
  if (needsName) {
    return (
      <RoomJoinGate
        roomId={roomId}
        initialName={username}
        onJoin={(name) => {
          setUsername(name);
          markUsernameConfirmed(name);
          setNeedsName(false);
        }}
      />
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
      {/* WebSocket connection manager (non-visual component) */}
      <WebSocketManager roomId={roomId} username={username} requestedRoomType={requestedRoomType} />

      {effectiveRoomType === "map" ? (
        <MapRoom roomId={roomId} />
      ) : IS_DEMO_MODE ? (
        <DemoDashboard roomId={roomId} />
      ) : (
        <Dashboard roomId={roomId} />
      )}
    </motion.div>
  );
};
