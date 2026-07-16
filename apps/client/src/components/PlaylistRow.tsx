import { cn, extractFileNameFromUrl, formatTime } from "@/lib/utils";
import { AudioSourceState, useGlobalStore } from "@/store/global";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertCircle, GripVertical, Loader2, Play, Pause } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import React from "react";

/**
 * Presentational, sortable playlist row shared by the synced queue
 * (QueueSortableItem) and the room pool (PoolRow). Owns layout, the drag
 * handle, the play/number indicator, name, and duration; the caller supplies
 * the click behavior (synced play vs local preview), the active/playing state
 * that drives the indicator, and the trailing action buttons.
 */
export const PlaylistRow = ({
  id,
  sourceState,
  index,
  canMutate,
  active,
  playing,
  onActivate,
  actions,
  showDuration = true,
}: {
  id: string;
  sourceState: AudioSourceState;
  index: number;
  canMutate: boolean;
  /** Row is the selected/highlighted one in its context. */
  active: boolean;
  /** Row is actively playing (implies active); drives the pause icon + sound-wave. */
  playing: boolean;
  onActivate: () => void;
  actions?: React.ReactNode;
  showDuration?: boolean;
}) => {
  const getAudioDuration = useGlobalStore((state) => state.getAudioDuration);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const isLoading = sourceState.status === "loading";
  const isError = sourceState.status === "error";

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <motion.div
        key={sourceState.source.url}
        layout
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          isDragging
            ? {
                layout: { duration: 0.15, ease: "backOut" },
                opacity: { duration: 0.3, delay: Math.min(0.05 * index, 0.3), ease: "easeOut" },
                y: { duration: 0.3, delay: Math.min(0.05 * index, 0.3), ease: "easeOut" },
              }
            : {
                layout: { type: "spring", stiffness: 400, damping: 45, mass: 1 },
                opacity: { duration: 0.3, delay: Math.min(0.05 * index, 0.3), ease: "easeOut" },
                y: { duration: 0.3, delay: Math.min(0.05 * index, 0.3), ease: "easeOut" },
              }
        }
        className={cn(
          "flex items-center pl-2 pr-4 py-3 rounded-md group transition-colors select-none",
          active ? "text-white hover:bg-neutral-700/20" : "text-neutral-300 hover:bg-neutral-700/20",
          !canMutate && "text-white/50",
          (isLoading || isError) && "opacity-60 cursor-not-allowed",
          isDragging && "bg-neutral-700/20"
        )}
        onClick={onActivate}
      >
        {/* Drag handle - only shown for users who can mutate */}
        {canMutate && (
          <motion.div
            {...listeners}
            className="p-1"
            initial={{ opacity: 0.25 }}
            animate={{ opacity: isDragging ? 1 : 0.25 }}
            whileHover={{ opacity: 1 }}
            style={{ cursor: "grab", touchAction: "none" }}
          >
            <GripVertical className="size-4" />
          </motion.div>
        )}

        {/* Track number / Play icon */}
        <div className="w-6 h-6 flex-shrink-0 flex items-center justify-center relative cursor-default select-none">
          <AnimatePresence mode="wait">
            {isLoading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.3, ease: "easeOut" } }}
                className="absolute inset-0 flex items-center justify-center"
              >
                <Loader2 className="size-4 animate-spin text-neutral-400" />
              </motion.div>
            ) : isError ? (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.3, ease: "easeOut" } }}
                className="absolute inset-0 flex items-center justify-center"
              >
                <AlertCircle className="size-4 text-red-400" />
              </motion.div>
            ) : (
              <motion.div
                key="loaded"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.3, ease: "easeOut" } }}
                className="absolute inset-0"
              >
                {/* Play/Pause button (shown on hover), only for mutators. */}
                {canMutate && (
                  <button className="text-white text-sm hover:scale-110 transition-transform w-full h-full flex items-center justify-center absolute inset-0 opacity-0 group-hover:opacity-100 select-none">
                    {playing ? (
                      <Pause className="fill-current size-3.5 stroke-1" />
                    ) : (
                      <Play className="fill-current size-3.5" />
                    )}
                  </button>
                )}

                <div
                  className={cn(
                    "w-full h-full flex items-center justify-center select-none",
                    canMutate && "group-hover:opacity-0"
                  )}
                >
                  {playing ? (
                    <div className="flex items-end justify-center h-4 w-4 gap-[2px]">
                      <div className="bg-primary-500 w-[2px] h-[40%] animate-[sound-wave-1_1.2s_ease-in-out_infinite]"></div>
                      <div className="bg-primary-500 w-[2px] h-[80%] animate-[sound-wave-2_1.4s_ease-in-out_infinite]"></div>
                      <div className="bg-primary-500 w-[2px] h-[60%] animate-[sound-wave-3_1s_ease-in-out_infinite]"></div>
                    </div>
                  ) : (
                    <span
                      className={cn(
                        "text-sm select-none",
                        canMutate && "group-hover:opacity-0",
                        active ? "text-primary-400" : "text-neutral-400"
                      )}
                    >
                      {index + 1}
                    </span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Track name */}
        <div className="flex-grow min-w-0 ml-3 select-none">
          <div
            className={cn(
              "font-medium text-sm truncate select-none",
              active && !isLoading ? "text-primary-400" : "",
              isError && "text-red-400",
              isLoading && "opacity-60"
            )}
          >
            {extractFileNameFromUrl(sourceState.source.url)}
            {sourceState.source.beatgrid && (
              <span className="ml-2 rounded bg-neutral-800 px-1 py-0.5 font-mono text-[10px] text-neutral-400">
                {sourceState.source.beatgrid.bpm}
              </span>
            )}
            {isError && sourceState.error && <span className="text-xs text-red-400 ml-2">({sourceState.error})</span>}
          </div>
        </div>

        {/* Duration & trailing actions */}
        <div className="ml-4 flex items-center gap-2">
          {showDuration && (
            <div className="text-xs text-neutral-500 select-none min-w-[3rem] text-right">
              {!isLoading && sourceState.status === "loaded" && active ? (
                formatTime(getAudioDuration({ url: sourceState.source.url }))
              ) : (
                <span className="text-neutral-700">--:--</span>
              )}
            </div>
          )}
          {actions}
        </div>
      </motion.div>
    </div>
  );
};
