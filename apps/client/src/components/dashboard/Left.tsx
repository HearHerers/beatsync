"use client";

import { cn } from "@/lib/utils";
import { useRoomStore } from "@/store/room";
import { Hash } from "lucide-react";
import { motion } from "motion/react";
import { AudioUploaderMinimal } from "../AudioUploaderMinimal";
import { Separator } from "../ui/separator";
import { BluetoothDelayControl } from "./BluetoothDelayControl";
import { ConnectedUsersList } from "./ConnectedUsersList";
import { RoomQRCode } from "./CopyRoom";
import { PlaybackPermissions } from "./PlaybackPermissions";

interface LeftProps {
  className?: string;
  /** When true, omit the bottom audio uploader (map rooms move upload to each
   *  shape's playlist column). */
  hideUploader?: boolean;
  /** Override the room header label. When set, the `#` icon is hidden and the
   *  label renders as `{roomLabel} {roomId}` (e.g. map rooms use "HearHere room"). */
  roomLabel?: string;
}

export const Left = ({ className, hideUploader = false, roomLabel }: LeftProps) => {
  const roomId = useRoomStore((state) => state.roomId);

  return (
    <motion.div
      className={cn(
        "w-full lg:w-80 lg:flex-shrink-0 border-l border-neutral-800/50 bg-neutral-900/50 backdrop-blur-md flex flex-col pb-4 lg:pb-0 text-sm space-y-1 overflow-y-auto flex-shrink-0 scrollbar-thin scrollbar-thumb-rounded-md scrollbar-thumb-muted-foreground/10 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/20",
        className
      )}
    >
      {/* Header section */}
      {/* <div className="px-3 py-2 flex items-center gap-2">
        <div className="bg-neutral-800 rounded-md p-1.5">
          <Music className="h-4 w-4 text-white" />
        </div>
        <h1 className="font-semibold text-white">Beatsync</h1>
      </div>


      <Separator className="bg-neutral-800/50" /> */}

      {/* Navigation menu */}
      <motion.div className="px-3.5 space-y-2.5 py-2 mt-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            {roomLabel ? (
              <span>
                {roomLabel} {roomId}
              </span>
            ) : (
              <>
                <Hash size={18} />
                <span>Room {roomId}</span>
              </>
            )}
          </div>

          {/* QR Code Dialog */}
          <RoomQRCode />
        </div>
      </motion.div>

      <Separator className="bg-neutral-800/50" />

      <PlaybackPermissions />

      <Separator className="bg-neutral-800/50" />

      {/* Desktop keeps the audio-output delay control here; on mobile it lives
          in the Settings tab (SettingsPanel) instead. */}
      <div className="hidden lg:block">
        <BluetoothDelayControl />
        <Separator className="bg-neutral-800/50" />
      </div>

      {/* Connected Users List */}
      <ConnectedUsersList />

      {/* Playback Permissions */}

      {/* <Separator className="bg-neutral-800/50" /> */}

      <motion.div className="mt-auto pb-4 pt-2 text-neutral-400">
        {!hideUploader && (
          <div className="pl-1">
            <AudioUploaderMinimal />
          </div>
        )}
      </motion.div>
    </motion.div>
  );
};
