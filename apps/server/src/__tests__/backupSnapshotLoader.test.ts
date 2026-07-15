import { describe, expect, it, mock } from "bun:test";
import { mockR2 } from "./mocks/r2";

// Mock BEFORE importing the loader so its @/lib/r2 binding resolves to the mock.
const syntheticBackup = {
  timestamp: Date.now() - 3 * 60_000,
  data: {
    rooms: {
      "482913": {
        clientDatas: [],
        globalVolume: 1,
        lowPassFreq: 20000,
        roomName: "Saturday Set",
        roomType: "map",
        shapes: [],
        playlists: [
          {
            id: "main",
            tracks: [{ url: "a.mp3" }],
            loop: false,
            playbackState: {
              type: "paused",
              audioSource: "",
              trackIndex: 0,
              serverTimeToExecute: 0,
              trackPositionSeconds: 0,
            },
          },
        ],
      },
    },
  },
};
mockR2({
  getLatestFileWithPrefix: mock(() => "state-backup/backup-2026-07-14_10-00-00.json"),
  downloadJSON: mock(() => syntheticBackup),
});

const { loadLatestBackup } = await import("../../scripts/lib/backupSnapshot");

describe("loadLatestBackup", () => {
  it("fetches, validates, and reports the age of the latest snapshot", async () => {
    const snapshot = await loadLatestBackup();
    expect(snapshot.key).toBe("state-backup/backup-2026-07-14_10-00-00.json");
    expect(snapshot.ageMinutes).toBe(3);
    const room = snapshot.backup.data.rooms["482913"];
    expect(room.roomName).toBe("Saturday Set");
    expect(room.playlists[0].tracks).toHaveLength(1);
  });
});
