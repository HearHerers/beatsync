// Beatgrid autoload (BEATGRID_AUTOLOAD_PLAN.md): BeatgridIndex load/fail-open,
// auto-attach at addTrackToContext, provenance-aware backfill (manual never
// touched, auto corrected), the restore→backfill startup-order guard, and the
// POST /admin/beatgrids/reload endpoint.

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "./mocks/r2";

const uploadJSON = mock(() => {
  /* noop */
});
mockR2({ uploadJSON });

import { INITIAL_PLAYLIST_PLAYBACK_STATE, MAIN_CONTEXT_ID, type BeatgridType } from "@beatsync/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { BeatgridIndex, getBeatgridIndex, setBeatgridIndex, loadBeatgridIndexFromFile } =
  await import("@/managers/BeatgridIndex");
const { RoomManager } = await import("@/managers/RoomManager");
const { globalManager } = await import("@/managers");
const { handleAdmin } = await import("@/routes/admin");

// Matches rekordbox-integration test data; URL display names via the ___ delimiter.
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
const HEAT3_GRID: BeatgridType = { bpm: 123.0, firstBeatSec: 0.052, firstDownbeatSec: 0.052, beatsPerBar: 4 };
const EXPORT_DOC = { beatsyncBeatgrids: 1 as const, tracks: [HEAT3_EXPORT] };

const r2Url = (displayName: string) =>
  `https://cdn.example.com/room-777777/${encodeURIComponent(`${displayName}___1770000000000.flac`)}`;
const HEAT3_URL = r2Url("06 - Shinichi Atobe - Heat 3");
const UNKNOWN_URL = r2Url("Some Unknown Track");

const ORIGINAL_SECRET = process.env.OPERATOR_SECRET;
const ORIGINAL_PATH = process.env.REKORDBOX_BEATGRIDS_PATH;

afterEach(() => {
  // The index is module-global; never leak a loaded one into other test files.
  setBeatgridIndex(new BeatgridIndex(null));
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.OPERATOR_SECRET;
  else process.env.OPERATOR_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_PATH === undefined) delete process.env.REKORDBOX_BEATGRIDS_PATH;
  else process.env.REKORDBOX_BEATGRIDS_PATH = ORIGINAL_PATH;
});

describe("BeatgridIndex", () => {
  it("resolves an R2 URL to its grid (filename and metadata keys)", () => {
    const index = new BeatgridIndex(EXPORT_DOC);
    expect(index.tracks).toBe(1);
    expect(index.gridForUrl(HEAT3_URL)?.beatgrid).toEqual(HEAT3_GRID);
    expect(index.gridForUrl(HEAT3_URL)?.durationSec).toBe(577);
    expect(index.gridForUrl(r2Url("Shinichi Atobe - Heat 3"))?.beatgrid).toEqual(HEAT3_GRID);
    expect(index.gridForUrl(UNKNOWN_URL)).toBeUndefined();
    expect(index.gridForUrl("not-a-url")).toBeUndefined();
  });

  it("loads from a file, and fails open on missing/invalid files", () => {
    const dir = mkdtempSync(join(tmpdir(), "beatgrids-"));
    try {
      const good = join(dir, "beatgrids.json");
      writeFileSync(good, JSON.stringify(EXPORT_DOC));
      const loaded = loadBeatgridIndexFromFile(good);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.index.gridForUrl(HEAT3_URL)?.beatgrid).toEqual(HEAT3_GRID);

      expect(loadBeatgridIndexFromFile(join(dir, "nope.json")).ok).toBe(false);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ hello: "world" }));
      expect(loadBeatgridIndexFromFile(bad).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RoomManager auto-attach + backfill", () => {
  beforeEach(() => {
    setBeatgridIndex(new BeatgridIndex(EXPORT_DOC));
  });

  it("attaches a grid from the index when a track enters a context", () => {
    const room = new RoomManager("autoload-room");
    room.addPlaylist("zoneA", { loop: true });
    room.addTrackToContext("zoneA", { url: HEAT3_URL });
    room.addTrackToContext("zoneA", { url: UNKNOWN_URL });

    const tracks = room.getPlaylist("zoneA")!.tracks;
    expect(tracks[0].beatgrid).toEqual(HEAT3_GRID);
    expect(tracks[0].beatgridSource).toBe("auto");
    expect(tracks[1].beatgrid).toBeUndefined();
    // Pool invariant: the mirrored main-context copy carries the grid too.
    const poolTrack = room.getPlaylist(MAIN_CONTEXT_ID)!.tracks.find((t) => t.url === HEAT3_URL);
    expect(poolTrack?.beatgrid).toEqual(HEAT3_GRID);
  });

  it("attaches on the audio-room add path too", () => {
    const room = new RoomManager("autoload-audio-room");
    const sources = room.addAudioSource({ url: HEAT3_URL });
    expect(sources[0].beatgrid).toEqual(HEAT3_GRID);
    expect(sources[0].beatgridSource).toBe("auto");
  });

  it("does nothing with an empty index", () => {
    setBeatgridIndex(new BeatgridIndex(null));
    const room = new RoomManager("autoload-empty");
    room.addPlaylist("zoneA", { loop: true });
    room.addTrackToContext("zoneA", { url: HEAT3_URL });
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid).toBeUndefined();
  });

  it("backfill fills missing grids and corrects stale auto grids, never manual ones", () => {
    setBeatgridIndex(new BeatgridIndex(null)); // adds land ungridded
    const room = new RoomManager("autoload-backfill");
    room.addPlaylist("zoneA", { loop: true });
    room.addTrackToContext("zoneA", { url: HEAT3_URL }); // no grid yet
    const manualUrl = r2Url("Shinichi Atobe - Heat 3");
    room.addTrackToContext("zoneA", { url: manualUrl });
    const manualGrid: BeatgridType = { bpm: 100, firstBeatSec: 1, firstDownbeatSec: 1, beatsPerBar: 4 };
    expect(room.setTrackBeatgrid(manualUrl, manualGrid)).toBeGreaterThan(0); // defaults to "manual"

    setBeatgridIndex(new BeatgridIndex(EXPORT_DOC));
    const changed = room.backfillBeatgrids();
    // HEAT3_URL appears in zoneA + the pool; the manual one is untouched.
    expect(changed).toBe(2);
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid).toEqual(HEAT3_GRID);
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgridSource).toBe("auto");
    const manualTrack = room.getPlaylist("zoneA")!.tracks.find((t) => t.url === manualUrl);
    expect(manualTrack?.beatgrid).toEqual(manualGrid);
    expect(manualTrack?.beatgridSource).toBe("manual");

    // A re-analysis changes the export → auto grids get corrected on reload.
    const corrected = { ...HEAT3_EXPORT, bpm: 124.0 };
    setBeatgridIndex(new BeatgridIndex({ beatsyncBeatgrids: 1, tracks: [corrected] }));
    expect(room.backfillBeatgrids()).toBe(2);
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid?.bpm).toBe(124.0);
    expect(manualTrack?.beatgrid).toEqual(manualGrid);

    // Unchanged index → no-op.
    expect(room.backfillBeatgrids()).toBe(0);
  });

  it("backfills tracks that arrived via restorePlaylists (startup-order guard)", () => {
    // Restore bypasses addTrackToContext, so the auto-attach hook never ran —
    // this is the boot path: load index → restore → backfill.
    const room = new RoomManager("autoload-restore");
    room.restorePlaylists([
      {
        id: MAIN_CONTEXT_ID,
        tracks: [{ url: HEAT3_URL }, { url: UNKNOWN_URL }],
        loop: false,
        playbackState: { ...INITIAL_PLAYLIST_PLAYBACK_STATE },
      },
    ]);
    expect(room.getPlaylist(MAIN_CONTEXT_ID)!.tracks[0].beatgrid).toBeUndefined();

    expect(room.backfillBeatgrids()).toBe(1);
    const tracks = room.getPlaylist(MAIN_CONTEXT_ID)!.tracks;
    expect(tracks[0].beatgrid).toEqual(HEAT3_GRID);
    expect(tracks[0].beatgridSource).toBe("auto");
    expect(tracks[1].beatgrid).toBeUndefined();
  });
});

// Duration verification + the duration+loose-title fallback tier
// (BEATGRID_MATCHING_PLAN.md Phase 2). RADIO and EXTENDED are two versions of
// the same title with different lengths and different grids — the exact
// wrong-version scenario the duration check exists for.
const RADIO = {
  file: "Anthem.mp3",
  title: "Anthem",
  artist: "DJ X",
  bpm: 128,
  durationSec: 210,
  firstBeatSec: 0.1,
  firstDownbeatSec: 0.1,
  beatsPerBar: 4,
  grid: "constant" as const,
};
const EXTENDED = {
  file: "Anthem (Extended Mix).mp3",
  title: "Anthem (Extended Mix)",
  artist: "DJ X",
  bpm: 128,
  durationSec: 420,
  firstBeatSec: 0.25,
  firstDownbeatSec: 0.25,
  beatsPerBar: 4,
  grid: "constant" as const,
};
const VERSIONS_DOC = { beatsyncBeatgrids: 1 as const, tracks: [RADIO, EXTENDED] };

describe("duration verification + fallback tier", () => {
  it("keeps an exact match when durations agree, vetoes + rescues when they don't", () => {
    const index = new BeatgridIndex(VERSIONS_DOC);
    const url = r2Url("Anthem"); // exact key hits RADIO
    // Duration unknown → exact match stands (existing behavior).
    expect(index.gridForUrl(url)?.beatgrid.firstBeatSec).toBe(0.1);
    // Duration agrees with RADIO → RADIO.
    expect(index.gridForUrl(url, 210.4)?.beatgrid.firstBeatSec).toBe(0.1);
    // Duration says this file is the extended version → exact RADIO match is
    // vetoed and the fallback tier finds EXTENDED (unique 420s candidate
    // whose stripped title "anthem" is contained in the display name).
    expect(index.gridForUrl(url, 419.8)?.beatgrid.firstBeatSec).toBe(0.25);
    expect(index.durationConflict(url, 419.8)).toBe(true);
    expect(index.durationConflict(url, 210.4)).toBe(false);
  });

  it("matches by duration + loose title when every exact key misses", () => {
    const index = new BeatgridIndex(VERSIONS_DOC);
    // Decorated display name no exact key covers: track number + edit suffix.
    const url = r2Url("01 - DJ X - Anthem (Club Edit)");
    expect(index.gridForUrl(url)).toBeUndefined(); // no duration → no fallback
    expect(index.gridForUrl(url, 210.5)?.beatgrid.firstBeatSec).toBe(0.1);
    expect(index.gridForUrl(url, 420.1)?.beatgrid.firstBeatSec).toBe(0.25);
    // Duration matching neither version → nothing.
    expect(index.gridForUrl(url, 300)).toBeUndefined();
  });

  it("refuses the fallback when more than one candidate survives", () => {
    const vip = { ...RADIO, file: "Anthem (VIP).mp3", title: "Anthem (VIP)", durationSec: 210.5 };
    const index = new BeatgridIndex({ beatsyncBeatgrids: 1, tracks: [RADIO, vip] });
    // Both entries are ~210s and both stripped titles ("anthem") are contained.
    expect(index.gridForUrl(r2Url("Some Anthem Bootleg"), 210.3)).toBeUndefined();
  });

  it("setTrackDuration stamps copies and attaches via the fallback tier", () => {
    setBeatgridIndex(new BeatgridIndex(VERSIONS_DOC));
    const room = new RoomManager("duration-attach");
    room.addPlaylist("zoneA", { loop: true });
    const url = r2Url("DJ X - Anthem (Radio Edit)"); // exact keys miss
    room.addTrackToContext("zoneA", { url });
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid).toBeUndefined();

    // First decode reports the duration → fallback attaches RADIO everywhere.
    expect(room.setTrackDuration(url, 210.2)).toBe(2); // zoneA + pool
    const track = room.getPlaylist("zoneA")!.tracks[0];
    expect(track.durationSec).toBe(210.2);
    expect(track.beatgrid?.firstBeatSec).toBe(0.1);
    expect(track.beatgridSource).toBe("auto");
    // Subsequent identical reports (other clients) are no-ops.
    expect(room.setTrackDuration(url, 210.23)).toBe(0);
  });

  it("setTrackDuration detaches a wrong-version name match; backfill agrees", () => {
    setBeatgridIndex(new BeatgridIndex({ beatsyncBeatgrids: 1, tracks: [RADIO] }));
    const room = new RoomManager("duration-detach");
    room.addPlaylist("zoneA", { loop: true });
    const url = r2Url("Anthem");
    room.addTrackToContext("zoneA", { url }); // exact name match → RADIO grid
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid?.firstBeatSec).toBe(0.1);

    // The real file turns out to be ~420s: the RADIO grid is for a different
    // version and there is no fallback winner → detach.
    expect(room.setTrackDuration(url, 419.9)).toBe(2);
    const track = room.getPlaylist("zoneA")!.tracks[0];
    expect(track.beatgrid).toBeUndefined();
    expect(track.beatgridSource).toBeUndefined();
    expect(track.durationSec).toBe(419.9);

    // Backfill won't re-attach it either (same duration evidence)...
    expect(room.backfillBeatgrids()).toBe(0);
    // ...but a corrected export (durations now agree) re-attaches on reload.
    setBeatgridIndex(new BeatgridIndex({ beatsyncBeatgrids: 1, tracks: [{ ...RADIO, durationSec: 420 }] }));
    expect(room.backfillBeatgrids()).toBe(2);
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid?.firstBeatSec).toBe(0.1);
  });

  it("rejects a mismatched attach at add time when the duration is already known", () => {
    setBeatgridIndex(new BeatgridIndex({ beatsyncBeatgrids: 1, tracks: [RADIO] }));
    const room = new RoomManager("duration-add-veto");
    room.addPlaylist("zoneA", { loop: true });
    // Provider stamped 420s at stream time; the 210s RADIO grid must not attach.
    room.addTrackToContext("zoneA", { url: r2Url("Anthem"), durationSec: 420 });
    expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid).toBeUndefined();
  });
});

describe("POST /admin/beatgrids/reload", () => {
  const request = (token?: string) =>
    [
      new Request("http://localhost:8080/admin/beatgrids/reload", {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      new URL("http://localhost:8080/admin/beatgrids/reload"),
    ] as const;

  beforeEach(() => {
    process.env.OPERATOR_SECRET = "s3cret";
    delete process.env.REKORDBOX_BEATGRIDS_PATH;
    uploadJSON.mockClear();
  });

  it("is invisible (404) without the operator secret", async () => {
    delete process.env.OPERATOR_SECRET;
    const [req, url] = request("anything");
    expect((await handleAdmin(req, url)).status).toBe(404);
  });

  it("400s when REKORDBOX_BEATGRIDS_PATH is unset, keeping the previous index", async () => {
    setBeatgridIndex(new BeatgridIndex(EXPORT_DOC));
    const [req, url] = request("s3cret");
    const res = await handleAdmin(req, url);
    expect(res.status).toBe(400);
    expect(getBeatgridIndex().tracks).toBe(1); // untouched
  });

  it("reloads the index, backfills resident rooms, broadcasts + backs up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beatgrids-admin-"));
    const roomId = "autoload-admin-room";
    try {
      const path = join(dir, "beatgrids.json");
      writeFileSync(path, JSON.stringify(EXPORT_DOC));
      process.env.REKORDBOX_BEATGRIDS_PATH = path;

      const room = globalManager.getOrCreateRoom(roomId);
      room.addPlaylist("zoneA", { loop: true });
      room.addTrackToContext("zoneA", { url: HEAT3_URL }); // index empty → ungridded

      const publish = mock(() => 0);
      const fakeServer = { publish } as unknown as Parameters<typeof handleAdmin>[2];
      const [req, url] = request("s3cret");
      const res = await handleAdmin(req, url, fakeServer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        indexTracks: number;
        changedTracks: number;
        changedRooms: Record<string, number>;
      };
      expect(body.ok).toBe(true);
      expect(body.indexTracks).toBe(1);
      expect(body.changedRooms[roomId]).toBe(2); // zoneA + pool copies
      expect(room.getPlaylist("zoneA")!.tracks[0].beatgrid).toEqual(HEAT3_GRID);
      expect(publish).toHaveBeenCalledTimes(1); // only the changed room notified
      expect(uploadJSON).toHaveBeenCalled(); // grids persisted via backup
    } finally {
      globalManager.deleteRoom(roomId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
