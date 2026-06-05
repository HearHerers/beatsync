// import { IS_DEMO_MODE } from "@/demo";
import { generateAudioFileName, uploadBytes } from "@/lib/r2";
import { globalManager } from "@/managers";
import { MUSIC_PROVIDER_MANAGER } from "@/managers/MusicProviderManager";
import { sendBroadcast } from "@/utils/responses";
import type { HandlerFunction } from "@/websocket/types";
import type { ExtractWSRequestFrom } from "@beatsync/shared";

// Map an audio MIME type to a file extension for the stored object key.
// Falls back to mp3 for unknown/generic types (e.g. application/octet-stream).
function audioExtensionFromContentType(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
  };
  return map[type] ?? "mp3";
}

export const handleStreamMusic: HandlerFunction<ExtractWSRequestFrom["STREAM_MUSIC"]> = async ({
  ws,
  message,
  server,
}) => {
  // Allow streaming from the provider (e.g. Navidrome) in demo mode.
  // if (IS_DEMO_MODE) return;
  const roomId = ws.data.roomId;

  // Require room to exist before processing stream request
  const room = globalManager.getRoom(roomId);
  if (!room) {
    console.error(`Stream request failed: Room ${roomId} not found`);
    return;
  }

  // Check if this track is already being streamed
  const trackId = message.trackId.toString();
  if (room.hasActiveStreamJob(trackId)) {
    console.log(`Track ${trackId} is already being streamed for room ${roomId}, ignoring duplicate request`);
    return;
  }

  // Add job to room and broadcast updated count
  room.addStreamJob(trackId);
  sendBroadcast({
    server,
    roomId,
    message: {
      type: "STREAM_JOB_UPDATE",
      activeJobCount: room.getActiveStreamJobCount(),
    },
  });

  try {
    // Get the stream URL from the music provider
    const streamResponse = await MUSIC_PROVIDER_MANAGER.stream(message.trackId);

    if (!streamResponse.success) {
      throw new Error("Failed to get stream URL");
    }

    const streamUrl = streamResponse.data.url;

    // Use provided track name or fallback to track ID
    const originalName = message.trackName ?? `track-${message.trackId}`;

    // Download the audio file
    console.log(`Downloading audio from: ${streamUrl}`);
    const response = await fetch(streamUrl);

    if (!response.ok) {
      throw new Error(`Failed to download audio: ${response.status}`);
    }

    // Get content type from response headers, fallback to audio/mpeg.
    // Providers serve varying formats (Navidrome returns the original file,
    // e.g. FLAC), so derive the file extension from the content type rather
    // than assuming .mp3 — keeps the object key and stored content type honest.
    const contentType = response.headers.get("content-type") ?? "audio/mpeg";
    const extension = audioExtensionFromContentType(contentType);

    // Generate a unique filename for R2
    const fileName = generateAudioFileName(`${originalName}.${extension}`);

    // Get audio bytes
    const arrayBuffer = await response.arrayBuffer();

    // Upload directly to R2
    console.log(`Uploading to R2: room-${roomId}/${fileName}`);
    const r2Url = await uploadBytes(arrayBuffer, roomId, fileName, contentType);

    // Add the audio source to the room and get updated sources list
    const sources = room.addAudioSource({ url: r2Url });

    console.log(`Successfully uploaded track to R2: ${r2Url}`);
    console.log(`Broadcasting new audio sources to room ${roomId}: ${sources.length} total sources`);

    // Broadcast to all room members that new audio is available
    sendBroadcast({
      server,
      roomId,
      message: {
        type: "ROOM_EVENT",
        event: {
          type: "SET_AUDIO_SOURCES",
          sources,
        },
      },
    });
  } catch (error) {
    console.error("Error in handleStreamMusic:", error);
  } finally {
    // Job completed or failed - remove from tracking and notify clients
    room.removeStreamJob(trackId);
    sendBroadcast({
      server,
      roomId,
      message: {
        type: "STREAM_JOB_UPDATE",
        activeJobCount: room.getActiveStreamJobCount(),
      },
    });
  }
};
