import { AudioSourceState, useGlobalStore } from "@/store/global";
import { sendWSRequest } from "@/utils/ws";
import { ClientActionEnum, MAIN_CONTEXT_ID } from "@beatsync/shared";
import { MinusIcon, Trash2 } from "lucide-react";
import { PlaylistRow } from "./PlaylistRow";

// Shared across all rows: collapse a rapid double-click into a single action.
// Without this the 2nd click of a double-click can land on a different row
// (rows reflow when the selection/playing highlight changes) or act on
// pre-update state, playing the wrong track (#97).
let lastActivateAt = 0;
const ACTIVATE_COOLDOWN_MS = 300;

/**
 * Synced-playback playlist row. Wires PlaylistRow to the room's synchronized
 * playback: clicking selects + plays through the NTP scheduler (audio-room
 * main, or a map-room shape context), and the trailing button removes the
 * track from this context (main => delete the source; shape => detach it).
 */
export const QueueSortableItem = ({
  id,
  sourceState,
  index,
  canMutate,
  contextId = MAIN_CONTEXT_ID,
}: {
  id: string;
  sourceState: AudioSourceState;
  index: number;
  canMutate: boolean;
  /** Which playlist context this item belongs to. */
  contextId?: string;
}) => {
  const isMain = contextId === MAIN_CONTEXT_ID;
  const selectedAudioUrl = useGlobalStore((state) => state.selectedAudioUrl);
  const mainIsPlaying = useGlobalStore((state) => state.isPlaying);
  const contextPlayback = useGlobalStore((state) =>
    isMain ? undefined : state.playlists.get(contextId)?.playbackState
  );
  const isSelected = isMain
    ? selectedAudioUrl === sourceState.source.url
    : contextPlayback?.audioSource === sourceState.source.url;
  const isPlaying = isMain ? mainIsPlaying : contextPlayback?.type === "playing";

  const handleItemClick = () => {
    if (!canMutate) return;
    // Don't allow interaction with loading or error tracks.
    if (sourceState.status === "loading" || sourceState.status === "error") return;

    // Ignore the 2nd click of a double-click (see lastActivateAt above).
    const now = Date.now();
    if (now - lastActivateAt < ACTIVATE_COOLDOWN_MS) return;
    lastActivateAt = now;

    const url = sourceState.source.url;
    // Read fresh state, not the render-time closure — under fast clicks the
    // closed-over selection can be stale.
    const st = useGlobalStore.getState();

    if (isMain) {
      // Audio-room behavior: change selection then play.
      if (url === st.selectedAudioUrl) {
        if (st.isPlaying) st.broadcastPause();
        else st.broadcastPlay();
      } else {
        st.changeAudioSource(url);
        st.broadcastPlay(0);
      }
      return;
    }

    // Per-context (map-room shape) behavior: directly broadcast PLAY/PAUSE for
    // this contextId. No global "selected" — the playback target is the URL.
    const socket = st.socket;
    if (!socket) return;
    const playback = st.playlists.get(contextId)?.playbackState;
    const selected = playback?.audioSource === url;
    const playing = playback?.type === "playing";
    if (selected && playing) {
      sendWSRequest({
        ws: socket,
        request: { type: ClientActionEnum.enum.PAUSE, contextId, audioSource: url, trackTimeSeconds: 0 },
      });
    } else {
      sendWSRequest({
        ws: socket,
        request: {
          type: ClientActionEnum.enum.PLAY,
          contextId,
          audioSource: url,
          trackTimeSeconds: selected ? (playback?.trackPositionSeconds ?? 0) : 0,
        },
      });
    }
  };

  return (
    <PlaylistRow
      id={id}
      sourceState={sourceState}
      index={index}
      canMutate={canMutate}
      active={Boolean(isSelected)}
      playing={Boolean(isSelected && isPlaying)}
      onActivate={handleItemClick}
      actions={
        canMutate ? (
          <button
            className="p-1 rounded-full text-neutral-500 hover:text-red-400 transition-colors hover:scale-110 duration-150 focus:outline-none focus:text-red-400 focus:scale-110"
            title={isMain ? "Delete from the room" : "Remove from this zone"}
            onClick={(e) => {
              e.stopPropagation();
              const socket = useGlobalStore.getState().socket;
              if (!socket) return;
              sendWSRequest({
                ws: socket,
                request: isMain
                  ? { type: ClientActionEnum.enum.DELETE_AUDIO_SOURCES, urls: [sourceState.source.url] }
                  : { type: ClientActionEnum.enum.REMOVE_TRACK_FROM_CONTEXT, contextId, url: sourceState.source.url },
              });
            }}
          >
            {isMain ? <Trash2 className="size-3.5" /> : <MinusIcon className="size-4" />}
          </button>
        ) : undefined
      }
    />
  );
};
