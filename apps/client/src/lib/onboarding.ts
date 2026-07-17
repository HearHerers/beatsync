// Per-room "has this device seen the onboarding wizard" flag (#80). Keyed by
// roomId so a first-time visitor is walked through setup once, but reloads and
// return visits to the same room skip straight in.

const KEY_PREFIX = "hearhere.onboarded.";

export function hasSeenOnboarding(roomId: string): boolean {
  if (typeof window === "undefined") return true; // never gate during SSR
  try {
    return window.localStorage.getItem(KEY_PREFIX + roomId) === "1";
  } catch {
    return true; // storage blocked → don't trap the user behind a wizard
  }
}

export function markOnboardingSeen(roomId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_PREFIX + roomId, "1");
  } catch {
    // ignore — worst case we show it again next time
  }
}
