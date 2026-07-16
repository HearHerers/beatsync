// Deterministic per-user "creature" emoji, derived from a stable id (clientId).
//
// Replaces the country-flag avatars (#98) — everyone at the same party shared
// one flag, which was useless for telling people apart. A creature is picked by
// hashing the clientId, so it's stable across reconnects and identical on every
// device, with no geolocation involved.

// Curated set of single-codepoint, visually distinct creatures. Avoid emoji that
// rely on ZWJ sequences or skin-tone modifiers so they render consistently.
const CREATURES = [
  "🦊",
  "🐙",
  "🦋",
  "🐢",
  "🦉",
  "🐝",
  "🐳",
  "🦕",
  "🦜",
  "🐬",
  "🦩",
  "🦔",
  "🦎",
  "🐸",
  "🐧",
  "🦑",
  "🐨",
  "🐼",
  "🦦",
  "🦥",
  "🐆",
  "🦓",
  "🦒",
  "🦌",
  "🐫",
  "🦙",
  "🦘",
  "🦡",
  "🦇",
  "🐺",
  "🦁",
  "🐯",
  "🐷",
  "🐹",
  "🐰",
  "🐻",
  "🐮",
  "🐵",
  "🦈",
  "🦖",
  "🐊",
  "🦚",
  "🦢",
  "🐌",
];

// djb2 string hash → non-negative int. Stable and dependency-free.
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/** Stable creature emoji for a user, keyed by their clientId (or any stable id). */
export function emojiForId(id: string | undefined | null): string {
  if (!id) return CREATURES[0];
  return CREATURES[hashString(id) % CREATURES.length];
}
