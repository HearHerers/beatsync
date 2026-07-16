"use client";
import { cn, extractFileNameFromUrl } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { AnimatePresence, motion } from "motion/react";
import { TopBar } from "../room/TopBar";
import { SyncProgress, WS_STATUS_COLORS } from "../ui/SyncProgress";
import { BeatPill, DemoBeatFlash } from "./BeatFlash";
import { Bottom } from "./Bottom";
import { RoomQRCode } from "./CopyRoom";
import { GlobalVolumeControl } from "./GlobalVolumeControl";
import { InlineSearch } from "./InlineSearch";
import { LowPassControl } from "./LowPassControl";
import { DemoLyrics } from "./DemoLyrics";
import { MetronomeButton } from "./Metronome";

const AUDIO_LOADING_RGB = WS_STATUS_COLORS.connecting;
const AUDIO_LOADED_RGB = WS_STATUS_COLORS.connected;

const AudioDot = ({ isLoaded }: { isLoaded: boolean }) => {
  const rgb = isLoaded ? AUDIO_LOADED_RGB : AUDIO_LOADING_RGB;
  return (
    <span className="relative flex size-2.5">
      {!isLoaded && (
        <span
          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
          style={{ backgroundColor: `rgb(${rgb})` }}
        />
      )}
      <span
        className="relative inline-flex size-2.5 rounded-full transition-colors duration-500"
        style={{
          backgroundColor: `rgb(${rgb})`,
          boxShadow: `0 0 6px 1px rgba(${rgb},0.5)`,
        }}
      />
    </span>
  );
};

const DemoTrackSelector = () => {
  const audioSources = useGlobalStore((state) => state.audioSources);
  const selectedAudioUrl = useGlobalStore((state) => state.selectedAudioUrl);

  if (audioSources.length <= 1) return null;

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {audioSources.map((source) => {
        const isSelected = source.source.url === selectedAudioUrl;
        return (
          <button
            key={source.source.url}
            onClick={() => {
              if (isSelected) return;
              const { changeAudioSource, broadcastPlay, isPlaying } = useGlobalStore.getState();
              changeAudioSource(source.source.url);
              if (isPlaying) broadcastPlay(0);
            }}
            className={cn(
              "text-xs font-mono px-3 py-1.5 rounded-full transition-colors cursor-pointer truncate max-w-48",
              isSelected
                ? "bg-white text-black"
                : "text-neutral-400 bg-neutral-800 hover:bg-neutral-700 hover:text-neutral-200"
            )}
          >
            {extractFileNameFromUrl(source.source.url)}
          </button>
        );
      })}
    </div>
  );
};

interface DemoDashboardProps {
  roomId: string;
}

export const DemoDashboard = ({ roomId }: DemoDashboardProps) => {
  const isSynced = useGlobalStore((state) => state.isSynced);
  const isLoadingAudio = useGlobalStore((state) => state.isInitingSystem);
  const hasUserStartedSystem = useGlobalStore((state) => state.hasUserStartedSystem);
  const demoUserCount = useGlobalStore((state) => state.demoUserCount);
  const demoAudioReadyCount = useGlobalStore((state) => state.demoAudioReadyCount);
  const isAdmin = useGlobalStore((state) => state.currentUser?.isAdmin ?? false);
  const isPlaying = useGlobalStore((state) => state.isPlaying);
  const isAudioLoaded = useGlobalStore(
    (state) => state.audioSources.length > 0 && state.audioSources.every((s) => s.status === "loaded")
  );

  const isReady = isSynced && !isLoadingAudio;

  return (
    <div className="w-full h-dvh flex flex-col text-white bg-neutral-950">
      <DemoBeatFlash />
      <TopBar roomId={roomId} />

      {!isSynced && hasUserStartedSystem && !isLoadingAudio && <SyncProgress />}

      {isReady && (
        <motion.div
          className="relative flex flex-1 flex-col overflow-hidden min-h-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex-1 flex items-center justify-center">
            {isPlaying ? (
              <DemoLyrics />
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="flex items-center gap-3 text-neutral-400">
                  <AudioDot isLoaded={isAudioLoaded} />
                  <span
                    className={cn(
                      "text-sm font-medium tracking-wide uppercase transition-colors duration-500",
                      isAudioLoaded ? "text-neutral-400" : "animate-pulse text-yellow-400"
                    )}
                  >
                    {isAudioLoaded ? "Audio Loaded" : "Loading Audio"}
                  </span>
                  {isAdmin && (
                    <span className="text-sm font-mono text-neutral-300 tabular-nums">
                      {demoAudioReadyCount}/{demoUserCount}
                    </span>
                  )}
                </div>
                <AnimatePresence mode="popLayout">
                  <motion.span
                    key={demoUserCount}
                    className="text-8xl md:text-9xl font-bold tabular-nums tracking-tight"
                    initial={{ opacity: 0, y: 20, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -20, filter: "blur(4px)" }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                  >
                    {demoUserCount}
                  </motion.span>
                </AnimatePresence>
                <RoomQRCode />
                <BeatPill />
              </div>
            )}
          </div>

          {isAdmin && (
            <div className="shrink-0 px-6 pb-4 flex flex-col gap-3">
              <InlineSearch />
              <DemoTrackSelector />
              <div className="flex flex-col lg:flex-row gap-3 [&_[data-slot=slider-track]]:before:inset-y-[-16px] [&_[data-slot=slider-track]]:h-2 [&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-thumb]]:opacity-100">
                <LowPassControl className="flex-1" isMobile />
                <GlobalVolumeControl className="flex-1" isMobile />
              </div>
              <div className="[&_button]:px-4 [&_button]:py-2 [&_button]:text-sm">
                <MetronomeButton />
              </div>
            </div>
          )}

          <Bottom />
        </motion.div>
      )}
    </div>
  );
};
