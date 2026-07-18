// Search-time beatgrid hints on Navidrome results: mapSong consults the
// BeatgridIndex by library-path basename, then "artist - title", with the
// provider-reported duration vetoing same-name/different-version matches.
// Display-only metadata — the authoritative grid still attaches when the
// track enters a room.

import { afterAll, afterEach, describe, expect, it } from "bun:test";

import { BeatgridIndex, setBeatgridIndex } from "@/managers/BeatgridIndex";
import { MusicProviderManager } from "@/managers/MusicProviderManager";

const HEAT3_EXPORT = {
  file: "06 - Shinichi Atobe - Heat 3.flac",
  title: "Heat 3",
  artist: "Shinichi Atobe",
  bpm: 123.0,
  durationSec: 577,
  firstBeatSec: 0.052,
  firstDownbeatSec: 0.052,
  beatsPerBar: 4,
  grid: "constant" as const,
};
const EXPORT_DOC = { beatsyncBeatgrids: 1 as const, tracks: [HEAT3_EXPORT] };

const ENV_KEYS = ["PROVIDER_TYPE", "PROVIDER_URL", "NAVIDROME_USER", "NAVIDROME_PASSWORD"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const ORIGINAL_FETCH = globalThis.fetch;

// Fresh instance (not the module singleton) so the constructor picks up the
// navidrome env set here.
function navidromeManager(): MusicProviderManager {
  process.env.PROVIDER_TYPE = "navidrome";
  process.env.PROVIDER_URL = "http://navidrome.test";
  process.env.NAVIDROME_USER = "u";
  process.env.NAVIDROME_PASSWORD = "p";
  return new MusicProviderManager();
}

function stubSearch3(songs: unknown[]) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ "subsonic-response": { status: "ok", searchResult3: { song: songs } } }))
    )) as unknown as typeof fetch;
}

afterEach(() => {
  // The index is module-global; never leak a loaded one into other test files.
  setBeatgridIndex(new BeatgridIndex(null));
  globalThis.fetch = ORIGINAL_FETCH;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Navidrome search beatgrid hints", () => {
  it("attaches bpm when the library path basename matches the export filename", async () => {
    setBeatgridIndex(new BeatgridIndex(EXPORT_DOC));
    stubSearch3([
      {
        id: "abc123",
        title: "Heat 3",
        artist: "Shinichi Atobe",
        duration: 577,
        path: "Shinichi Atobe/Butterfly Effect/06 - Shinichi Atobe - Heat 3.flac",
      },
    ]);

    const result = await navidromeManager().search("heat");
    expect(result.data.tracks.items[0].beatgrid).toEqual({ bpm: 123.0 });
  });

  it("falls back to the artist - title key when there is no path", async () => {
    setBeatgridIndex(new BeatgridIndex(EXPORT_DOC));
    stubSearch3([{ id: "abc123", title: "Heat 3", artist: "Shinichi Atobe", duration: 577 }]);

    const result = await navidromeManager().search("heat");
    expect(result.data.tracks.items[0].beatgrid).toEqual({ bpm: 123.0 });
  });

  it("omits the hint for tracks the index does not know", async () => {
    setBeatgridIndex(new BeatgridIndex(EXPORT_DOC));
    stubSearch3([{ id: "zzz", title: "Some Unknown Track", artist: "Nobody", duration: 200 }]);

    const result = await navidromeManager().search("unknown");
    expect(result.data.tracks.items[0].beatgrid).toBeUndefined();
  });

  it("vetoes a name match whose duration disagrees (different version)", async () => {
    setBeatgridIndex(new BeatgridIndex(EXPORT_DOC));
    stubSearch3([{ id: "abc123", title: "Heat 3", artist: "Shinichi Atobe", duration: 300 }]);

    const result = await navidromeManager().search("heat");
    expect(result.data.tracks.items[0].beatgrid).toBeUndefined();
  });

  it("omits the hint when no index is loaded", async () => {
    stubSearch3([{ id: "abc123", title: "Heat 3", artist: "Shinichi Atobe", duration: 577 }]);

    const result = await navidromeManager().search("heat");
    expect(result.data.tracks.items[0].beatgrid).toBeUndefined();
  });
});
