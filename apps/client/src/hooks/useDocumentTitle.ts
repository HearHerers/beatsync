import { extractFileNameFromUrl } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { useEffect } from "react";

export const useDocumentTitle = () => {
  const isPlaying = useGlobalStore((state) => state.isPlaying);
  const selectedAudioUrl = useGlobalStore((state) => state.selectedAudioUrl);
  const getSelectedTrack = useGlobalStore((state) => state.getSelectedTrack);

  useEffect(() => {
    const track = getSelectedTrack();
    if (isPlaying && track) {
      const songName = extractFileNameFromUrl(track.source.url);
      document.title = `${songName}`;
    } else {
      document.title = "HearHere";
    }
  }, [isPlaying, selectedAudioUrl, getSelectedTrack]);
};
