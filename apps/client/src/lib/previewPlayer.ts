"use client";
// Local, unsynced audition of a room-pool track. Deliberately NOT the synced
// playback path (no NTP scheduler, no WebSocket, no AudioContext decode) — it
// just plays the URL in a throwaway <audio> element so an operator can hear
// what a pool track is before adding it to a zone. One preview at a time.

import { create } from "zustand";

let el: HTMLAudioElement | null = null;

interface PreviewState {
  /** URL currently previewing, or null when nothing is playing. */
  url: string | null;
  /** Toggle preview for a URL: starts it, or stops it if it's already the one playing. */
  toggle: (url: string) => void;
  stop: () => void;
}

export const usePreviewPlayer = create<PreviewState>((set, get) => ({
  url: null,
  toggle: (url) => {
    if (get().url === url) {
      get().stop();
      return;
    }
    if (!el) el = new Audio();
    el.pause();
    el.src = url;
    el.onended = () => set({ url: null });
    void el.play().catch(() => set({ url: null }));
    set({ url });
  },
  stop: () => {
    if (el) {
      el.pause();
      el.onended = null;
      el.removeAttribute("src");
    }
    set({ url: null });
  },
}));
