import type { UploadCompleteResponseType, UploadUrlResponseType } from "@beatsync/shared";
import { GetUploadUrlSchema, R2_AUDIO_FILE_NAME_DELIMITER, UploadCompleteSchema } from "@beatsync/shared";
import type { BunServer } from "@/utils/websocket";
import {
  createKey,
  generateAudioFileName,
  generatePresignedUploadUrl,
  getObjectSize,
  getPublicAudioUrl,
  keyFromPublicUrl,
  roomIdFromUrl,
  validateR2Config,
} from "@/lib/r2";
import { globalManager } from "@/managers";
import type { RoomManager } from "@/managers/RoomManager";
import { errorResponse, jsonResponse, sendBroadcast } from "@/utils/responses";

/**
 * The human-readable display name encoded in one of our uploaded object URLs
 * (the part of the basename before the `___` uniquifier), or null for URLs
 * that don't carry one (external/registered URLs, default tracks).
 */
export function displayNameFromUrl(url: string): string | null {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const delimiterIndex = base.indexOf(R2_AUDIO_FILE_NAME_DELIMITER);
    return delimiterIndex === -1 ? null : base.substring(0, delimiterIndex);
  } catch {
    return null;
  }
}

/**
 * A track among `candidateUrls` that is (almost certainly) the same file:
 * same display name AND same byte size. Returns its URL, or null. Only the
 * room's own uploaded objects are considered — external URLs can't be
 * size-checked, and other rooms' objects shouldn't be cross-referenced.
 * The URL/size resolvers are parameters so tests can supply fakes without
 * S3 config; the route passes the real r2 implementations.
 */
export async function findDuplicateTrack(params: {
  candidateUrls: string[];
  roomId: string;
  targetDisplayName: string;
  fileSizeBytes: number;
  resolveRoomId: (url: string) => string | null;
  resolveKey: (url: string) => string | null;
  resolveSize: (key: string) => Promise<number | null>;
}): Promise<string | null> {
  for (const url of params.candidateUrls) {
    if (params.resolveRoomId(url) !== params.roomId) continue;
    if (displayNameFromUrl(url) !== params.targetDisplayName) continue;
    const key = params.resolveKey(url);
    if (!key) continue;
    const size = await params.resolveSize(key);
    if (size === params.fileSizeBytes) return url;
  }
  return null;
}

/** findDuplicateTrack against a live room, wired to the real r2 helpers. */
function findRoomDuplicate(
  room: RoomManager,
  roomId: string,
  fileName: string,
  fileSizeBytes: number
): Promise<string | null> {
  return findDuplicateTrack({
    candidateUrls: room.getAllTrackUrls(),
    roomId,
    // Run the incoming name through the production sanitizer so the comparison
    // matches exactly what an earlier upload of this file was stored as.
    targetDisplayName: generateAudioFileName(fileName).split(R2_AUDIO_FILE_NAME_DELIMITER)[0],
    fileSizeBytes,
    resolveRoomId: roomIdFromUrl,
    resolveKey: keyFromPublicUrl,
    resolveSize: getObjectSize,
  });
}

// New endpoint to get presigned upload URL
export const handleGetPresignedURL = async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    // Validate R2 configuration first
    const r2Validation = validateR2Config();
    if (!r2Validation.isValid) {
      console.error("R2 configuration errors:", r2Validation.errors);
      return errorResponse("R2 configuration not complete", 500);
    }

    const body: unknown = await req.json();
    const parseResult = GetUploadUrlSchema.safeParse(body);

    if (!parseResult.success) {
      return errorResponse(`Invalid request data: ${parseResult.error.message}`, 400);
    }

    const { roomId, fileName, contentType, fileSizeBytes } = parseResult.data;

    // Check if room exists
    const room = globalManager.getRoom(roomId);
    if (!room) {
      return errorResponse("Room not found. Please join the room before uploading files.", 404);
    }

    // Dedupe: when the caller supplies the file size, a track with the same
    // display name and byte size already in the room is the same file — answer
    // with its URL so the caller references it instead of storing a copy.
    if (fileSizeBytes !== undefined) {
      const existingUrl = await findRoomDuplicate(room, roomId, fileName, fileSizeBytes);
      if (existingUrl) {
        console.log(`Upload dedupe: "${fileName}" (${fileSizeBytes} B) already in room ${roomId} as ${existingUrl}`);
        const response: UploadUrlResponseType = { existingUrl };
        return jsonResponse(response);
      }
    }

    // Generate unique filename
    const uniqueFileName = generateAudioFileName(fileName);
    const r2Key = createKey(roomId, uniqueFileName);

    // Generate presigned URL for upload
    const uploadUrl = await generatePresignedUploadUrl(roomId, uniqueFileName, contentType);
    const publicUrl = getPublicAudioUrl(roomId, uniqueFileName);

    console.log(`Generated presigned URL for upload - R2 key: (${r2Key})`);

    const response: UploadUrlResponseType = {
      uploadUrl,
      publicUrl,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error("Error generating upload URL:", error);
    return errorResponse("Failed to generate upload URL", 500);
  }
};

// Endpoint to confirm successful upload and broadcast to room
export const handleUploadComplete = async (req: Request, server: BunServer) => {
  try {
    if (req.method !== "POST") {
      return errorResponse("Method not allowed", 405);
    }

    const body: unknown = await req.json();
    const parseResult = UploadCompleteSchema.safeParse(body);

    if (!parseResult.success) {
      return errorResponse(`Invalid request data: ${parseResult.error.message}`, 400);
    }

    const { roomId, publicUrl, contextId } = parseResult.data;

    // Check if room exists
    const room = globalManager.getRoom(roomId);
    if (!room) {
      return errorResponse("Room not found. The room may have been closed during upload.", 404);
    }

    // When contextId is provided (map rooms uploading to a specific shape's
    // playlist), append to that context. Otherwise fall back to the legacy
    // room-wide audioSources list (audio rooms).
    if (contextId !== undefined) {
      const tracks = room.addTrackToContext(contextId, { url: publicUrl });
      if (!tracks) {
        return errorResponse(`Playlist context "${contextId}" not found in room ${roomId}.`, 404);
      }
    } else {
      const sources = room.addAudioSource({ url: publicUrl });
      console.log(`✅ Audio upload completed - broadcasting to room ${roomId} new sources: ${JSON.stringify(sources)}`);
    }

    // Broadcast to room that new audio is available. SET_AUDIO_SOURCES is the
    // back-compat audio-room channel and only meaningful for the main context;
    // PLAYLISTS_UPDATE is the unified per-context channel that newer UI (and
    // map rooms) reads from. We always send PLAYLISTS_UPDATE so every context
    // mirror stays in sync; SET_AUDIO_SOURCES is only sent for main uploads.
    if (contextId === undefined) {
      sendBroadcast({
        server,
        roomId,
        message: {
          type: "ROOM_EVENT",
          event: {
            type: "SET_AUDIO_SOURCES",
            sources: room.getAudioSources(),
          },
        },
      });
    }
    sendBroadcast({
      server,
      roomId,
      message: {
        type: "ROOM_EVENT",
        event: { type: "PLAYLISTS_UPDATE", playlists: room.getPlaylistsView() },
      },
    });

    const response: UploadCompleteResponseType = { success: true };
    return jsonResponse(response);
  } catch (error) {
    console.error("Error confirming upload:", error);
    return errorResponse("Failed to confirm upload", 500);
  }
};
