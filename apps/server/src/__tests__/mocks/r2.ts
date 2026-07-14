import { mock } from "bun:test";
import * as actualR2 from "@/lib/r2";

/**
 * Default R2 mock that stubs all external R2 operations as no-ops.
 * Call `mockR2()` at the top of your test file (before any imports that use R2).
 *
 * For custom overrides, pass a partial map:
 * ```ts
 * mockR2({ downloadJSON: mock(() => myData) })
 * ```
 */
export function mockR2(overrides: Record<string, ReturnType<typeof mock>> = {}): void {
  const defaults: Record<string, ReturnType<typeof mock>> = {
    deleteObjectsWithPrefix: mock(() => ({ deletedCount: 0 })),
    uploadJSON: mock(() => {
      /* noop */
    }),
    downloadJSON: mock(() => null),
    getLatestFileWithPrefix: mock(() => null),
    getSortedFilesWithPrefix: mock(() => []),
    deleteObject: mock(() => {
      /* noop */
    }),
    validateAudioFileExists: mock(() => true),
    cleanupOrphanedRooms: mock(() => ({
      orphanedRooms: [],
      totalRooms: 0,
      totalFiles: 0,
    })),
    generatePresignedUploadUrl: mock(() => "https://mock-r2/presigned"),
    listObjectsWithPrefix: mock(() => []),
    copyObjectIntoRoom: mock(() => null),
    uploadFile: mock(() => "https://mock-r2/uploaded"),
    uploadBytes: mock(() => "https://mock-r2/uploaded"),
  };

  // Spread the real module first so every export exists on the mock. Pure
  // helpers (extractKeyFromUrl, createKey, keyFromPublicUrl, ...) stay real;
  // only network-touching functions are stubbed. Without the spread, whichever
  // test file loads first installs a module missing those named exports, and
  // any later import of them throws — test-order dependent (broke only on CI's
  // Linux file ordering, not locally on macOS).
  void mock.module("@/lib/r2", () => ({ ...actualR2, ...defaults, ...overrides }));
}
