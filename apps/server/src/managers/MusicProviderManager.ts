import {
  RawSearchResponseSchema,
  SearchParamsSchema,
  StreamResponseSchema,
  TrackParamsSchema,
} from "@beatsync/shared/";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";

type ProviderType = "qobuz" | "navidrome";

// Page size for Navidrome search3 requests (Qobuz uses provider-side default).
const NAVIDROME_PAGE_SIZE = 20;
const SUBSONIC_API_VERSION = "1.16.1";
const SUBSONIC_CLIENT_NAME = "beatsync";

// Minimal shape of a Subsonic `search3` song entry that we consume. Navidrome
// returns many more fields (OpenSubsonic), but these are all we map.
interface SubsonicSong {
  id: string;
  title?: string;
  album?: string;
  albumId?: string;
  artist?: string;
  track?: number;
  year?: number;
  duration?: number;
}

export class MusicProviderManager {
  private providerUrl: string | undefined;
  private providerType: ProviderType;
  private navidromeUser: string | undefined;
  private navidromePassword: string | undefined;
  private navidromeStreamFormat: string;
  private navidromeStreamMaxBitRate: string;

  constructor() {
    // Lazy initialization - don't throw in constructor for test compatibility
    this.providerUrl = process.env.PROVIDER_URL;
    this.providerType = (process.env.PROVIDER_TYPE ?? "qobuz").toLowerCase() as ProviderType;
    this.navidromeUser = process.env.NAVIDROME_USER;
    this.navidromePassword = process.env.NAVIDROME_PASSWORD;
    // Transcode target for Navidrome streams (see streamNavidrome). "raw"
    // disables transcoding and fetches the untouched original file.
    this.navidromeStreamFormat = (process.env.NAVIDROME_STREAM_FORMAT ?? "mp3").toLowerCase();
    this.navidromeStreamMaxBitRate = process.env.NAVIDROME_STREAM_MAX_BITRATE ?? "320";
  }

  private getProviderUrl(): string {
    if (!this.providerUrl) {
      throw new Error("PROVIDER_URL environment variable is required");
    }
    // Strip any trailing slash so we can safely append `/rest/...` etc. without
    // dropping a configured base path (e.g. http://127.0.0.1:4533/sounds).
    return this.providerUrl.replace(/\/+$/, "");
  }

  async search(query: string, offset = 0): Promise<z.infer<typeof RawSearchResponseSchema>> {
    if (this.providerType === "navidrome") {
      return this.searchNavidrome(query, offset);
    }
    return this.searchQobuz(query, offset);
  }

  async stream(trackId: string) {
    if (this.providerType === "navidrome") {
      return this.streamNavidrome(trackId);
    }
    return this.streamQobuz(trackId);
  }

  // ===================== Qobuz (original provider) =====================

  private async searchQobuz(query: string, offset = 0): Promise<z.infer<typeof RawSearchResponseSchema>> {
    try {
      const { q, offset: validOffset } = SearchParamsSchema.parse({
        q: query,
        offset,
      });

      const searchUrl = new URL("/api/search", this.getProviderUrl());
      searchUrl.searchParams.set("q", q);
      searchUrl.searchParams.set("offset", validOffset.toString());

      const response = await fetch(searchUrl.toString());

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: unknown = await response.json();

      return RawSearchResponseSchema.parse(data);
    } catch (error) {
      throw new Error(`Search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async streamQobuz(trackId: string) {
    try {
      const { id } = TrackParamsSchema.parse({ id: trackId });

      const streamUrl = new URL("/api/track", this.getProviderUrl());
      streamUrl.searchParams.set("id", id.toString());

      const response = await fetch(streamUrl.toString());

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: unknown = await response.json();

      return StreamResponseSchema.parse(data);
    } catch (error) {
      throw new Error(`Download failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  // ===================== Navidrome (Subsonic API) =====================

  // Builds the Subsonic salted-token auth params (u/t/s) plus the standard
  // version/client/format params. Token = md5(password + salt), per the
  // Subsonic auth spec; the password is never sent over the wire.
  private subsonicParams(extra: Record<string, string> = {}): URLSearchParams {
    if (!this.navidromeUser || !this.navidromePassword) {
      throw new Error("NAVIDROME_USER and NAVIDROME_PASSWORD are required for the navidrome provider");
    }
    const salt = randomBytes(8).toString("hex");
    const token = createHash("md5")
      .update(this.navidromePassword + salt)
      .digest("hex");
    return new URLSearchParams({
      u: this.navidromeUser,
      t: token,
      s: salt,
      v: SUBSONIC_API_VERSION,
      c: SUBSONIC_CLIENT_NAME,
      f: "json",
      ...extra,
    });
  }

  // Maps a Subsonic song into the provider TrackSchema shape the client expects.
  // Many Qobuz-specific fields have no Subsonic equivalent and are filled with
  // sensible defaults. Cover art is left empty (the UI has an inline fallback);
  // wiring real artwork requires a server-side cover-art proxy (see notes).
  private mapSong(song: SubsonicSong): z.infer<typeof RawSearchResponseSchema>["data"]["tracks"]["items"][number] {
    const duration = song.duration ?? 0;
    return {
      performer: { name: song.artist ?? "Unknown Artist", id: 0 },
      album: {
        image: { small: "", thumbnail: "", large: "" },
        title: song.album ?? "Unknown Album",
        duration,
        parental_warning: false,
        id: song.albumId ?? "",
        release_date_original: song.year?.toString() ?? "",
      },
      track_number: song.track ?? 0,
      title: song.title ?? "Unknown Title",
      version: null,
      duration,
      parental_warning: false,
      id: song.id,
    };
  }

  private async searchNavidrome(query: string, offset = 0): Promise<z.infer<typeof RawSearchResponseSchema>> {
    try {
      const { q, offset: validOffset } = SearchParamsSchema.parse({ q: query, offset });

      const params = this.subsonicParams({
        query: q,
        songCount: NAVIDROME_PAGE_SIZE.toString(),
        songOffset: validOffset.toString(),
        // We only surface songs in the beatsync search UI.
        artistCount: "0",
        albumCount: "0",
      });
      const url = `${this.getProviderUrl()}/rest/search3?${params.toString()}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const body = (await response.json()) as {
        "subsonic-response"?: {
          status?: string;
          error?: { code?: number; message?: string };
          searchResult3?: { song?: SubsonicSong[] };
        };
      };
      const sr = body["subsonic-response"];
      if (sr?.status !== "ok") {
        throw new Error(`Subsonic error: ${sr?.error?.message ?? "unknown"} (code ${sr?.error?.code ?? "?"})`);
      }

      const songs = sr.searchResult3?.song ?? [];
      const items = songs.map((song) => this.mapSong(song));

      // Subsonic search3 doesn't return a total count. Signal "more available"
      // when we got a full page (client computes hasMore = offset+len < total).
      const total = items.length === NAVIDROME_PAGE_SIZE ? validOffset + items.length + 1 : validOffset + items.length;

      return RawSearchResponseSchema.parse({
        data: {
          tracks: {
            limit: NAVIDROME_PAGE_SIZE,
            offset: validOffset,
            total,
            items,
          },
        },
      });
    } catch (error) {
      throw new Error(`Search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  // Not async: building the signed stream URL is synchronous (the server-side
  // fetch happens later in handleStreamMusic). Returns a value that `stream()`'s
  // Promise wraps, matching the async streamQobuz branch.
  private streamNavidrome(trackId: string) {
    try {
      const { id } = TrackParamsSchema.parse({ id: trackId });

      // Ask Navidrome to transcode (default mp3 @ 320kbps) instead of serving
      // the untouched original. Originals are often FLAC — 30-90 MB per track —
      // which makes every zone play wait on a huge download + decode in each
      // listener's browser before any sound, and ogg/opus originals don't
      // decode in Safari at all. Every client receives the SAME re-hosted
      // bytes, so cross-client sync is unaffected by transcoding.
      //
      // NAVIDROME_STREAM_FORMAT=raw restores the original-file behavior
      // (Subsonic treats format=raw on /rest/stream as "no transcoding").
      // NAVIDROME_STREAM_MAX_BITRATE tunes the target bitrate (default 320).
      // The token is baked into this URL; handleStreamMusic fetches it server
      // side and re-hosts the bytes to object storage, so it never reaches a
      // browser.
      const params = this.subsonicParams({
        id,
        format: this.navidromeStreamFormat,
        ...(this.navidromeStreamFormat !== "raw" && { maxBitRate: this.navidromeStreamMaxBitRate }),
      });
      const url = `${this.getProviderUrl()}/rest/stream?${params.toString()}`;

      return StreamResponseSchema.parse({ success: true, data: { url } });
    } catch (error) {
      throw new Error(`Download failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }
}

// Export singleton instance
export const MUSIC_PROVIDER_MANAGER = new MusicProviderManager();
