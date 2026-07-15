import {
  DiscoverRoomsType,
  GetActiveRoomsType,
  GetDefaultAudioType,
  GetUploadUrlType,
  UploadCompleteResponseType,
  UploadCompleteType,
  UploadUrlResponseType,
} from "@beatsync/shared";
import axios from "axios";
import { getApiUrl } from "./urls";

const baseAxios = axios.create({
  baseURL: getApiUrl(),
  withCredentials: true,
});

export const uploadAudioFile = async (data: { file: File; roomId: string; contextId?: string }) => {
  try {
    // Step 1: Get presigned upload URL from server. The size hint lets the
    // server answer with an existing track's URL when the same file (display
    // name + byte size) is already in the room, instead of a presigned URL.
    const uploadUrlRequest: GetUploadUrlType = {
      roomId: data.roomId,
      fileName: data.file.name,
      contentType: data.file.type,
      fileSizeBytes: data.file.size,
    };

    const presignedURLResponse = await baseAxios.post<UploadUrlResponseType>(
      "/upload/get-presigned-url",
      uploadUrlRequest
    );

    const presigned = presignedURLResponse.data;

    // Duplicate: skip the upload entirely and register a reference to the
    // existing object (in the requested context, if any).
    if ("existingUrl" in presigned) {
      const dedupeCompleteRequest: UploadCompleteType = {
        roomId: data.roomId,
        originalName: data.file.name,
        publicUrl: presigned.existingUrl,
        ...(data.contextId !== undefined && { contextId: data.contextId }),
      };
      await baseAxios.post<UploadCompleteResponseType>("/upload/complete", dedupeCompleteRequest);
      return {
        success: true,
        publicUrl: presigned.existingUrl,
        deduped: true,
      };
    }

    const { uploadUrl, publicUrl } = presigned;

    // Step 2: Upload directly to R2 using presigned URL
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      body: data.file,
      headers: {
        "Content-Type": data.file.type,
      },
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.statusText}`);
    }

    // Step 3: Notify server that upload completed successfully
    const uploadCompleteRequest: UploadCompleteType = {
      roomId: data.roomId,
      originalName: data.file.name,
      publicUrl,
      ...(data.contextId !== undefined && { contextId: data.contextId }),
    };

    await baseAxios.post<UploadCompleteResponseType>("/upload/complete", uploadCompleteRequest);

    return {
      success: true,
      publicUrl,
      deduped: false,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.data?.message || "Failed to upload audio file");
    }
    throw error;
  }
};

/**
 * Register an externally-hosted audio URL with the room without going through
 * the R2 presigned-upload flow. The URL must be CORS-allowing and serve audio.
 * Useful for dev/testing without R2 configured.
 */
export const registerAudioUrl = async (data: { url: string; roomId: string; name?: string; contextId?: string }) => {
  try {
    const body: UploadCompleteType = {
      roomId: data.roomId,
      originalName: data.name ?? data.url.split("/").pop() ?? "external-url",
      publicUrl: data.url,
      ...(data.contextId !== undefined && { contextId: data.contextId }),
    };
    await baseAxios.post<UploadCompleteResponseType>("/upload/complete", body);
    return { success: true, publicUrl: data.url };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.data?.message || "Failed to register URL");
    }
    throw error;
  }
};

export const fetchAudio = async (url: string) => {
  try {
    // Direct fetch from R2 public URL - zero server bandwidth
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch audio: ${response.statusText}`);
    }

    return await response.blob();
  } catch (error) {
    throw new Error(`Failed to fetch audio: ${error}`);
  }
};

export async function fetchDefaultAudioSources() {
  try {
    const response = await fetch(`${getApiUrl()}/default`);

    if (!response.ok) {
      console.error("Failed to fetch default audio sources:", response.status);
      return [];
    }

    const files: GetDefaultAudioType = await response.json();
    return files;
  } catch (error) {
    console.error("Error fetching default audio sources:", error);
    return [];
  }
}

export async function fetchActiveRooms() {
  const response = await fetch(`${getApiUrl()}/active-rooms`);
  const data: GetActiveRoomsType = await response.json();
  return data;
}

export async function fetchDiscoverRooms() {
  const response = await fetch(`${getApiUrl()}/discover`);
  const data: DiscoverRoomsType = await response.json();
  return data;
}
