// Persisted display name + a "confirmed" flag (#68).
//
// The homepage Join form lets you pick a name before entering a room, but people
// who open a shared room link skip that form and used to get an unmodifiable
// random name until they found the in-room rename control. We persist the chosen
// name and remember whether the user has explicitly confirmed one, so we prompt
// once (on first join from a link) and then never again.

const NAME_KEY = "hearhere.username";
const CONFIRMED_KEY = "hearhere.usernameConfirmed";

export function loadSavedUsername(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(NAME_KEY);
  } catch {
    return null; // storage blocked (private mode / cookies off)
  }
}

export function hasConfirmedUsername(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONFIRMED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the name and mark it explicitly chosen, so we don't prompt again. */
export function markUsernameConfirmed(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NAME_KEY, name);
    window.localStorage.setItem(CONFIRMED_KEY, "1");
  } catch {
    // ignore storage failures — worst case we prompt again next time
  }
}
