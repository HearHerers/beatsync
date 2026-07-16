// Pure helpers for the bulk track import CLI (scripts/import-tracks.ts).
// Standalone on purpose — no imports from src/ — so the script stays a thin
// client of the running server's HTTP API.

import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

// Extension → MIME type, matching the client's <input accept> list
// (AudioUploaderMinimal.tsx). GetUploadUrlSchema requires audio/* or
// video/webm; .webm maps to video/webm to mirror what browsers report.
export const AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".flac": "audio/flac",
};

/**
 * MIME type for a file name based on its extension (case-insensitive),
 * or null if it isn't a supported audio format.
 */
export function contentTypeForFile(fileName: string): string | null {
  const ext = extname(fileName).toLowerCase();
  return AUDIO_CONTENT_TYPES[ext] ?? null;
}

/**
 * Expand file/directory paths into a sorted list of audio file paths.
 *
 * Directories are scanned recursively; dotfiles and dot-directories (.DS_Store,
 * AppleDouble ._* files, .git, …) and non-audio files are skipped silently.
 * Explicitly named files are held to a higher bar: a missing path or a
 * non-audio extension throws, since that's almost certainly a mistake.
 * Sorted output keeps the import (and thus playlist) order deterministic.
 */
export async function collectAudioFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];

  const scanDirectory = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDirectory(fullPath);
      } else if (entry.isFile() && contentTypeForFile(entry.name) !== null) {
        files.push(fullPath);
      }
    }
  };

  for (const path of paths) {
    const info = await stat(path); // throws with a clear ENOENT for missing paths
    if (info.isDirectory()) {
      await scanDirectory(path);
    } else if (contentTypeForFile(path) !== null) {
      files.push(path);
    } else {
      throw new Error(
        `${path} is not a supported audio file (expected one of: ${Object.keys(AUDIO_CONTENT_TYPES).join(", ")})`
      );
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Human-readable byte count for progress lines, e.g. 4404019 → "4.2 MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}
