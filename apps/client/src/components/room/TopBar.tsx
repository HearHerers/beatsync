"use client";
import { SOCIAL_LINKS } from "@/constants";
import { audioContextManager } from "@/lib/audioContextManager";
import { MAX_NTP_MEASUREMENTS, useCanMutate, useGlobalStore } from "@/store/global";
import { useRoomStore } from "@/store/room";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum } from "@beatsync/shared";
import { Crown, Hash, Pencil, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import { FaDiscord, FaGithub } from "react-icons/fa";
import { SyncProgress } from "../ui/SyncProgress";

interface TopBarProps {
  roomId: string;
}

export const TopBar = ({ roomId }: TopBarProps) => {
  const isLoadingAudio = useGlobalStore((state) => state.isInitingSystem);
  const isSynced = useGlobalStore((state) => state.isSynced);
  const roundTripEstimate = useGlobalStore((state) => state.roundTripEstimate);
  const connectedClientCount = useGlobalStore((state) => state.connectedClients.length);
  const clockOffset = useGlobalStore((state) => state.offsetEstimate);
  const syncMeasurementCount = useGlobalStore((state) => state.syncMeasurements.length);

  // Get current user from global store to check admin status
  const currentUser = useGlobalStore((state) => state.currentUser);
  const isAdmin = currentUser?.isAdmin || false;

  // Show minimal nav bar when synced and not loading
  if (!isLoadingAudio && isSynced) {
    return (
      <div className="h-8 bg-black/80 backdrop-blur-md z-50 flex items-center justify-between px-4 border-b border-zinc-800">
        <div className="flex items-center space-x-4 text-xs text-neutral-400 py-2 md:py-0">
          {isAdmin && (
            <div className="flex items-center">
              <Crown className="h-3 w-3 text-green-500" fill="currentColor" />
            </div>
          )}
          <Link href="/" className="font-medium hover:text-white transition-colors">
            Beatsync
          </Link>

          {/* NTP Measurements Indicator */}
          <div className="items-center hidden md:flex">
            <motion.svg width="14" height="14" viewBox="0 0 14 14" className="mr-1">
              <circle
                cx="7"
                cy="7"
                r="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-neutral-600"
              />
              <motion.circle
                cx="7"
                cy="7"
                r="5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="text-green-500"
                strokeDasharray={`${(syncMeasurementCount / MAX_NTP_MEASUREMENTS) * 31.4} 31.4`}
                strokeLinecap="round"
                transform="rotate(-90 7 7)"
                initial={{ strokeDasharray: "0 31.4" }}
                animate={{
                  strokeDasharray: `${(syncMeasurementCount / MAX_NTP_MEASUREMENTS) * 31.4} 31.4`,
                }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
              />
            </motion.svg>
            <span className="text-xs">
              {syncMeasurementCount}/{MAX_NTP_MEASUREMENTS}
            </span>
          </div>
          <RoomNameAndId roomId={roomId} />
          <div className="flex items-center">
            <Users size={12} className="mr-1" />
            <span className="flex items-center">
              <span className="mr-1.5">
                {connectedClientCount} {connectedClientCount === 1 ? "user" : "users"}
              </span>
            </span>
          </div>
          {/* Hide separator on small screens */}
          <div className="hidden md:block">|</div>
          {/* Hide Offset/RTT on small screens */}
          <div className="hidden md:flex items-center space-x-2">
            <span>Offset: {clockOffset.toFixed(2)}ms</span>
            <span>RTT: {roundTripEstimate.toFixed(2)}ms</span>
            <span>OL: {((audioContextManager.getContext().outputLatency ?? 0) * 1000).toFixed(0)}ms</span>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2.5">
          {/* Discord icon */}
          <a
            href={SOCIAL_LINKS.discord}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-400 hover:text-white transition-colors"
          >
            <FaDiscord className="size-[17px]" />
          </a>
          {/* GitHub icon in the top right */}
          <a
            href={SOCIAL_LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-400 hover:text-white transition-colors"
          >
            <FaGithub className="size-4" />
          </a>
        </div>
      </div>
    );
  }

  // Use the existing SyncProgress component for loading/syncing states
  return (
    <AnimatePresence>
      {isLoadingAudio && (
        <motion.div exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
          <SyncProgress />
        </motion.div>
      )}
    </AnimatePresence>
  );
};

/**
 * Inline room name + id. Admins (and anyone who can mutate in EVERYONE jam mode)
 * see a click-to-edit pencil affordance; non-mutators just see the static name.
 * Enter / blur commits, Esc cancels. Empty + commit clears the name on the
 * server, which surfaces back as the plain "# <id>" fallback.
 */
function RoomNameAndId({ roomId }: { roomId: string }) {
  const roomName = useRoomStore((s) => s.roomName);
  const canMutate = useCanMutate();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const startEdit = () => {
    if (!canMutate) return;
    setDraft(roomName ?? "");
    setIsEditing(true);
  };
  const commit = () => {
    setIsEditing(false);
    const next = draft.trim();
    // No-op if unchanged (avoid an unnecessary broadcast).
    if (next === (roomName ?? "")) return;
    const ws = useGlobalStore.getState().socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendWSRequest({
      ws,
      request: { type: ClientActionEnum.enum.SET_ROOM_NAME, roomName: next },
    });
  };
  const cancel = () => {
    setIsEditing(false);
    setDraft("");
  };

  if (isEditing) {
    return (
      <div className="flex items-center">
        <Hash size={12} className="mr-1" />
        <input
          autoFocus
          value={draft}
          maxLength={80}
          placeholder={`Room ${roomId}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="bg-transparent border border-neutral-700 rounded px-1 text-xs text-white outline-none focus:border-neutral-500 min-w-32"
        />
        <span className="ml-2 text-neutral-600">#{roomId}</span>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center ${canMutate ? "cursor-pointer hover:text-white" : ""}`}
      onClick={startEdit}
      title={canMutate ? "Click to rename room" : undefined}
    >
      <Hash size={12} className="mr-1" />
      {roomName ? (
        <>
          <span className="flex items-center text-neutral-200">{roomName}</span>
          <span className="ml-2 text-neutral-600">#{roomId}</span>
        </>
      ) : (
        <span className="flex items-center">{roomId}</span>
      )}
      {canMutate && <Pencil size={10} className="ml-1.5 text-neutral-600 group-hover:text-neutral-400" />}
    </div>
  );
}
