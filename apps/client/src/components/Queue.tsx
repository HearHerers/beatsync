import {
  closestCenter,
  DndContext,
  DragEndEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis, restrictToWindowEdges } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { AudioSourceState, useCanMutate, useGlobalStore } from "@/store/global";
import { MAIN_CONTEXT_ID } from "@beatsync/shared";
import { motion } from "motion/react";
import React from "react";
import LoadDefaultTracksButton from "./LoadDefaultTracksButton";
import { QueueSortableItem } from "./QueueSortableItem";

interface QueueProps extends React.ComponentProps<"div"> {
  /** Which playlist context to render. Defaults to MAIN_CONTEXT_ID (audio-room main). */
  contextId?: string;
}

export const Queue = ({ className, contextId = MAIN_CONTEXT_ID, ...rest }: QueueProps) => {
  const isMain = contextId === MAIN_CONTEXT_ID;
  const audioSources = useGlobalStore((state) => state.audioSources);
  const playlist = useGlobalStore((state) => state.playlists.get(contextId));
  const isInitingSystem = useGlobalStore((state) => state.isInitingSystem);
  const broadcastReorder = useGlobalStore((state) => state.broadcastReorder);
  const canMutate = useCanMutate();

  // Project per-context tracks into the AudioSourceState shape that
  // QueueSortableItem understands. For the main context this is just
  // audioSources verbatim; for shape contexts we look up loading state from
  // the global audioSources registry by URL.
  const items: AudioSourceState[] = React.useMemo(() => {
    if (isMain) return audioSources;
    if (!playlist) return [];
    const byUrl = new Map(audioSources.map((as) => [as.source.url, as]));
    // Loading state comes from the global registry, but the source object comes
    // from the playlist — it carries per-track metadata (e.g. beatgrid) that the
    // registry's copy may lack.
    return playlist.tracks.map((t) => {
      const registered = byUrl.get(t.url);
      return registered ? { ...registered, source: t } : { source: t, status: "idle" as const };
    });
  }, [isMain, audioSources, playlist]);

  // Reordering works in any context (audio-room "main" and map-room shapes
  // alike) for anyone allowed to mutate the room.
  const canReorder = canMutate;

  const sensors = useSensors(
    // Small distance threshold so grabbing the drag handle doesn't fire the
    // row's click-to-play before a drag is recognized.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    })
  );

  function handleDragEnd(event: DragEndEvent): void {
    if (!canReorder) return;
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      const oldIndex = items.findIndex((src) => src.source.url === active.id);
      const newIndex = items.findIndex((src) => src.source.url === over.id);
      const newItems = arrayMove(items, oldIndex, newIndex);
      const orderedUrls = newItems.map((it) => it.source.url);
      broadcastReorder(contextId, orderedUrls);
    }
  }

  return (
    <div className={cn("", className)} {...rest}>
      <div className="space-y-1">
        {items.length > 0 ? (
          canReorder ? (
            <DndContext
              sensors={sensors}
              onDragEnd={handleDragEnd}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToWindowEdges]}
            >
              <SortableContext items={items.map((src) => src.source.url)} strategy={verticalListSortingStrategy}>
                {items.map((sourceState, index) => (
                  <QueueSortableItem
                    key={sourceState.source.url}
                    id={sourceState.source.url}
                    sourceState={sourceState}
                    index={index}
                    canMutate={canMutate}
                    contextId={contextId}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            items.map((sourceState, index) => (
              <QueueSortableItem
                key={sourceState.source.url}
                id={sourceState.source.url}
                sourceState={sourceState}
                index={index}
                canMutate={canMutate}
                contextId={contextId}
              />
            ))
          )
        ) : (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="w-full text-center text-neutral-300 select-none flex flex-col items-center justify-center gap-3"
          >
            {isInitingSystem ? (
              "Loading tracks..."
            ) : canMutate ? (
              isMain ? (
                <>
                  <div className="text-sm text-neutral-400">No tracks yet</div>
                  <LoadDefaultTracksButton />
                </>
              ) : (
                <div className="text-sm text-neutral-400">No tracks in this zone yet</div>
              )
            ) : (
              "No tracks available"
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
};
