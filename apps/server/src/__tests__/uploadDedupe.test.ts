// Presign-step dedupe: when the client supplies fileSizeBytes and the room
// already has a track with the same display name AND byte size, the route
// answers { existingUrl } so the caller references the existing object instead
// of uploading a second copy. findDuplicateTrack takes its URL/size resolvers
// as parameters, so these tests inject fakes — no r2 module mocking, which
// would leak into other test files' view of @/lib/r2.

import { describe, expect, it } from "bun:test";
import { displayNameFromUrl, findDuplicateTrack } from "@/routes/upload";

const CDN = "https://cdn.test";
const POOL_URL = `${CDN}/room-777001/My%20Song___2025-06-01T00-00:00.000Z.mp3`;

const resolveRoomId = (url: string): string | null => {
  if (!url.startsWith(`${CDN}/`)) return null;
  const match = /^room-([^/]+)\//.exec(url.slice(CDN.length + 1));
  return match ? match[1] : null;
};
const resolveKey = (url: string): string | null =>
  url.startsWith(`${CDN}/`)
    ? url
        .slice(CDN.length + 1)
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/")
    : null;

const sizes = (bytes: number | null) => () => Promise.resolve(bytes);

const base = {
  roomId: "777001",
  targetDisplayName: "My Song",
  fileSizeBytes: 1234,
  resolveRoomId,
  resolveKey,
  resolveSize: sizes(1234),
};

describe("displayNameFromUrl", () => {
  it("decodes the basename and strips the ___ uniquifier", () => {
    expect(displayNameFromUrl(POOL_URL)).toBe("My Song");
  });

  it("returns null when there is no uniquifier (external URLs, default tracks)", () => {
    expect(displayNameFromUrl("https://elsewhere.example/My%20Song.mp3")).toBeNull();
  });

  it("returns null for unparseable URLs", () => {
    expect(displayNameFromUrl("not a url")).toBeNull();
  });
});

describe("findDuplicateTrack", () => {
  it("matches a room track with the same name and size", async () => {
    const url = await findDuplicateTrack({ ...base, candidateUrls: [POOL_URL] });
    expect(url).toBe(POOL_URL);
  });

  it("rejects when the byte size differs (same name, different file)", async () => {
    const url = await findDuplicateTrack({
      ...base,
      candidateUrls: [POOL_URL],
      resolveSize: sizes(999999),
    });
    expect(url).toBeNull();
  });

  it("rejects when the object's size can't be determined", async () => {
    const url = await findDuplicateTrack({
      ...base,
      candidateUrls: [POOL_URL],
      resolveSize: sizes(null),
    });
    expect(url).toBeNull();
  });

  it("never matches external URLs (no display-name uniquifier)", async () => {
    const url = await findDuplicateTrack({
      ...base,
      candidateUrls: ["https://elsewhere.example/My%20Song.mp3"],
    });
    expect(url).toBeNull();
  });

  it("never matches another room's objects", async () => {
    const url = await findDuplicateTrack({
      ...base,
      candidateUrls: [`${CDN}/room-888888/My%20Song___2025-06-01T00-00:00.000Z.mp3`],
    });
    expect(url).toBeNull();
  });

  it("skips non-matching candidates and returns the first real match", async () => {
    const url = await findDuplicateTrack({
      ...base,
      candidateUrls: [
        "https://elsewhere.example/My%20Song.mp3",
        `${CDN}/room-777001/Other%20Song___2025-06-01T00-00:00.000Z.mp3`,
        POOL_URL,
      ],
    });
    expect(url).toBe(POOL_URL);
  });
});
