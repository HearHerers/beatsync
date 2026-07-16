import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAudioFiles, contentTypeForFile, formatBytes } from "../../scripts/lib/importTracks";

describe("contentTypeForFile", () => {
  it("maps supported audio extensions to MIME types", () => {
    expect(contentTypeForFile("song.mp3")).toBe("audio/mpeg");
    expect(contentTypeForFile("song.flac")).toBe("audio/flac");
    expect(contentTypeForFile("song.m4a")).toBe("audio/mp4");
  });

  it("maps .webm to video/webm (the schema's special case)", () => {
    expect(contentTypeForFile("clip.webm")).toBe("video/webm");
  });

  it("is case-insensitive on the extension", () => {
    expect(contentTypeForFile("SONG.MP3")).toBe("audio/mpeg");
    expect(contentTypeForFile("Song.Wav")).toBe("audio/wav");
  });

  it("returns null for unsupported or missing extensions", () => {
    expect(contentTypeForFile("notes.txt")).toBeNull();
    expect(contentTypeForFile("no-extension")).toBeNull();
    expect(contentTypeForFile("archive.mp3.zip")).toBeNull();
  });
});

describe("collectAudioFiles", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "import-tracks-test-"));
    await mkdir(join(root, "nested", "deeper"), { recursive: true });
    await mkdir(join(root, ".hidden-dir"), { recursive: true });
    await writeFile(join(root, "b.mp3"), "x");
    await writeFile(join(root, "a.flac"), "x");
    await writeFile(join(root, "notes.txt"), "x");
    await writeFile(join(root, ".DS_Store"), "x");
    await writeFile(join(root, "._b.mp3"), "x");
    await writeFile(join(root, "nested", "c.ogg"), "x");
    await writeFile(join(root, "nested", "deeper", "d.WAV"), "x");
    await writeFile(join(root, ".hidden-dir", "e.mp3"), "x");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scans directories recursively, skipping dotfiles and non-audio, sorted", async () => {
    const files = await collectAudioFiles([root]);
    expect(files).toEqual([
      join(root, "a.flac"),
      join(root, "b.mp3"),
      join(root, "nested", "c.ogg"),
      join(root, "nested", "deeper", "d.WAV"),
    ]);
  });

  it("accepts explicitly named audio files alongside directories", async () => {
    const files = await collectAudioFiles([join(root, "nested"), join(root, "b.mp3")]);
    expect(files).toEqual([
      join(root, "b.mp3"),
      join(root, "nested", "c.ogg"),
      join(root, "nested", "deeper", "d.WAV"),
    ]);
  });

  it("throws when an explicitly named file is not audio", async () => {
    const error = await collectAudioFiles([join(root, "notes.txt")]).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("not a supported audio file");
  });

  it("throws for paths that do not exist", async () => {
    const error = await collectAudioFiles([join(root, "missing")]).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(Error);
  });
});

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4404019)).toBe("4.2 MB");
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });
});
