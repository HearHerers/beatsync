// Bulk-import local audio files into a room — a thin client of the running
// server's public upload flow, making the same three calls the browser makes
// (see src/routes/upload.ts and apps/client/src/lib/api.ts):
//
//   1. POST /upload/get-presigned-url  → presigned PUT URL + public URL
//   2. PUT the file bytes to storage   → direct to R2/MinIO
//   3. POST /upload/complete           → registers the track + broadcasts
//
//   bun run room:import <roomId> <file-or-dir>... [--context <shapeId>]
//                       [--concurrency <n>] [--dry-run]
//
//     --context <shapeId>   append to that zone's playlist (map rooms) instead
//                           of the room-wide queue
//     --concurrency <n>     parallel uploads (default 4)
//     --dry-run             list what would be imported and exit
//
// Requires the server running (SERVER_URL to override http://localhost:8080).
// The room must already exist; run this on the server host so the file bytes
// travel to storage over loopback/LAN instead of a browser uplink.

import type { GetUploadUrlType, UploadCompleteType, UploadUrlResponseType } from "@beatsync/shared";
import { basename } from "node:path";
import pLimit from "p-limit";
import { collectAudioFiles, contentTypeForFile, formatBytes } from "./lib/importTracks";

const USAGE =
  "Usage: bun run scripts/import-tracks.ts <roomId> <file-or-dir>... [--context <shapeId>] [--concurrency <n>] [--dry-run]";

const SERVER_URL = (process.env.SERVER_URL ?? "http://localhost:8080").replace(/\/$/, "");

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Could not reach ${SERVER_URL} (${err instanceof Error ? err.message : String(err)}). Is the server running?`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} returned ${res.status}${text ? ` (${text})` : ""}`);
  }
  return res.json() as Promise<T>;
}

async function getPresignedUrl(
  roomId: string,
  fileName: string,
  contentType: string,
  fileSizeBytes?: number
): Promise<UploadUrlResponseType> {
  const body: GetUploadUrlType = { roomId, fileName, contentType, fileSizeBytes };
  return postJSON<UploadUrlResponseType>("/upload/get-presigned-url", body);
}

// Steps 1 + 2 for one file: presign, then PUT the bytes straight to storage.
// Returns the public URL to register in step 3.
async function uploadFileBytes(roomId: string, filePath: string): Promise<string> {
  const fileName = basename(filePath);
  const contentType = contentTypeForFile(fileName)!; // collectAudioFiles only returns supported files
  const bytes = await Bun.file(filePath).arrayBuffer();
  const presigned = await getPresignedUrl(roomId, fileName, contentType, bytes.byteLength);

  // Dedup: the server already has this exact file (display name + byte size) in
  // the room, so it returns the existing object's URL and there's nothing to
  // upload. Mirrors the client's uploadAudioFile (lib/api.ts).
  if ("existingUrl" in presigned) {
    return presigned.existingUrl;
  }

  // Content-Type must match the presigned PutObjectCommand or the signature
  // check fails; likewise the body must be fixed-length bytes — a streamed
  // (chunked) body has no Content-Length and MinIO rejects the signature (403).
  const res = await fetch(presigned.uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`storage PUT returned ${res.status} ${res.statusText}`);
  }
  return presigned.publicUrl;
}

interface CliArgs {
  roomId: string;
  paths: string[];
  contextId?: string;
  concurrency: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let contextId: string | undefined;
  let concurrency = 4;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--context" || arg === "--concurrency") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value.\n${USAGE}`);
      if (arg === "--context") {
        contextId = value;
      } else {
        concurrency = Number.parseInt(value, 10);
        if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error(`--concurrency must be a positive integer.`);
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag ${arg}.\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }

  const [roomId, ...paths] = positional;
  if (!roomId || paths.length === 0) throw new Error(USAGE);
  return { roomId, paths, contextId, concurrency, dryRun };
}

async function main() {
  const { roomId, paths, contextId, concurrency, dryRun } = parseArgs(process.argv.slice(2));

  const files = await collectAudioFiles(paths);
  if (files.length === 0) {
    console.error("No audio files found in the given paths.");
    process.exit(1);
  }

  const target = `room ${roomId}${contextId ? ` (zone ${contextId})` : ""}`;
  let totalBytes = 0;
  for (const file of files) totalBytes += Bun.file(file).size;
  console.log(`Importing ${files.length} file(s), ${formatBytes(totalBytes)} total, into ${target} via ${SERVER_URL}`);

  if (dryRun) {
    for (const file of files) console.log(`  ${file} (${formatBytes(Bun.file(file).size)})`);
    console.log("\nDRY RUN — nothing uploaded. Re-run without --dry-run to import.");
    return;
  }

  // Preflight: presigning is side-effect free, so use it to verify the room
  // exists and fail once, fast, instead of once per file.
  await getPresignedUrl(roomId, basename(files[0]), contentTypeForFile(basename(files[0]))!);

  // PUTs run concurrently; registration (step 3) happens in sorted-file order
  // below so the playlist order matches the directory listing regardless of
  // which upload finishes first.
  const limit = pLimit(concurrency);
  const uploads = files.map((file) =>
    limit(() => uploadFileBytes(roomId, file)).catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err))
    )
  );

  let imported = 0;
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const label = `[${i + 1}/${files.length}]`;
    const name = basename(files[i]);
    const result = await uploads[i];
    if (result instanceof Error) {
      console.error(`${label} ❌ ${name} — ${result.message}`);
      failed++;
      continue;
    }
    try {
      const body: UploadCompleteType = { roomId, originalName: name, publicUrl: result, contextId };
      await postJSON("/upload/complete", body);
      console.log(`${label} ✅ ${name} (${formatBytes(Bun.file(files[i]).size)})`);
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${label} ❌ ${name} — ${message}`);
      failed++;
      // A bad --context fails every registration identically; stop after the first.
      if (contextId && message.includes("not found")) {
        console.error(`Zone "${contextId}" does not exist in room ${roomId} — aborting remaining registrations.`);
        failed += files.length - i - 1;
        break;
      }
    }
  }

  console.log(`\nDone: imported ${imported}, failed ${failed}, of ${files.length} file(s) into ${target}.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`import-tracks failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
