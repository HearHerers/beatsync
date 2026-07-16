// Regression tests for public-URL → object-key classification, which must be
// correct for BOTH virtual-hosted PUBLIC_URLs (https://cdn.example.com) and
// path-style ones that carry the bucket in the path (https://host/bucket).
// The path-style case previously folded the bucket into the key and broke
// playlist import (roomId parsed as null, CopySource double-bucketed).
//
// r2.ts reads S3_CONFIG from process.env at module load, so each case sets the
// env then imports a fresh module instance via a cache-busting query.

import { describe, expect, it } from "bun:test";
import type * as R2Module from "@/lib/r2";

async function loadR2(publicUrl: string, bucket = "beatsync-audio"): Promise<typeof R2Module> {
  process.env.S3_BUCKET_NAME = bucket;
  process.env.S3_PUBLIC_URL = publicUrl;
  process.env.S3_ENDPOINT = "https://s3.example.com";
  process.env.S3_ACCESS_KEY_ID = "x";
  process.env.S3_SECRET_ACCESS_KEY = "y";
  return import(`@/lib/r2?cachebust=${Math.random()}`) as Promise<typeof R2Module>;
}

const FILE = "Black%20Tambourine%20-%20Black%20Car___2026-07-06T22-15%3A53.118Z.mp3";
const DECODED = "Black Tambourine - Black Car___2026-07-06T22-15:53.118Z.mp3";

describe("keyFromPublicUrl / roomIdFromUrl / isOwnBucketUrl", () => {
  it("path-style PUBLIC_URL (bucket in path): key excludes the bucket segment", async () => {
    const r2 = await loadR2("https://s3.pc.hearhere.now/beatsync-audio");
    const url = `https://s3.pc.hearhere.now/beatsync-audio/room-851790/${FILE}`;
    expect(r2.keyFromPublicUrl(url)).toBe(`room-851790/${DECODED}`);
    expect(r2.roomIdFromUrl(url)).toBe("851790");
    expect(r2.isOwnBucketUrl(url)).toBe(true);
  });

  it("virtual-hosted PUBLIC_URL: key is the path", async () => {
    const r2 = await loadR2("https://cdn.example.com");
    const url = `https://cdn.example.com/room-851790/${FILE}`;
    expect(r2.keyFromPublicUrl(url)).toBe(`room-851790/${DECODED}`);
    expect(r2.roomIdFromUrl(url)).toBe("851790");
  });

  it("same host but different bucket path is NOT ours", async () => {
    const r2 = await loadR2("https://s3.pc.hearhere.now/beatsync-audio");
    const url = "https://s3.pc.hearhere.now/other-bucket/room-1/x.mp3";
    expect(r2.keyFromPublicUrl(url)).toBeNull();
    expect(r2.isOwnBucketUrl(url)).toBe(false);
    expect(r2.roomIdFromUrl(url)).toBeNull();
  });

  it("foreign host is not ours", async () => {
    const r2 = await loadR2("https://s3.pc.hearhere.now/beatsync-audio");
    const url = "https://elsewhere.example/beatsync-audio/room-1/x.mp3";
    expect(r2.isOwnBucketUrl(url)).toBe(false);
    expect(r2.roomIdFromUrl(url)).toBeNull();
  });

  it("our-bucket URL without a room- prefix has no room id", async () => {
    const r2 = await loadR2("https://cdn.example.com");
    const url = "https://cdn.example.com/default/track.mp3";
    expect(r2.isOwnBucketUrl(url)).toBe(true);
    expect(r2.roomIdFromUrl(url)).toBeNull();
  });

  // Restore-time track validation must not drop external (music-provider)
  // tracks: they aren't R2 objects, so there is nothing to HEAD. This
  // short-circuits before any network call. (Regression: restore dropped every
  // Navidrome track — and, via bucket-in-key derivation, every uploaded track
  // on path-style deployments — on server restart.)
  it("validateAudioFileExists keeps non-bucket URLs without hitting R2", async () => {
    const r2 = await loadR2("https://s3.pc.hearhere.now/beatsync-audio");
    expect(await r2.validateAudioFileExists("https://navidrome.example/rest/stream?id=123")).toBe(true);
  });
});
