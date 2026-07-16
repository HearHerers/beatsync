// Per-room admin token persistence. hearhere room admin is a recoverable
// per-room token: the server issues it to the room's creator (SET_ADMIN_TOKEN),
// we stash it here, and re-present it on every connect (?roomAdminToken=) so the
// creator stays a curator across reconnects, restarts, and devices that have it.
// Sharing the token grants co-curator access.

const KEY_PREFIX = "beatsync-admin-token:";

export function getAdminToken(roomId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + roomId);
  } catch {
    return null;
  }
}

export function setAdminToken(roomId: string, token: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + roomId, token);
  } catch {
    // localStorage unavailable (private mode, etc.) — admin won't persist across
    // reconnects from this browser, but the live session still works.
  }
}
