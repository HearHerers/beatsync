// Operator archive / delete: endpoint behavior, discovery exclusion, join
// rejection, and — the critical property — deletes that stay deleted across a
// restore (tombstones), while re-created rooms restore normally.

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "./mocks/r2";
import { createMockWs } from "./mocks/websocket";

// Stateful R2 mock: an in-memory key/value store shared by backups + registry.
let store: Record<string, unknown> = {};
let deletedPrefixes: string[] = [];
const uploadJSON = mock((key: string, data: unknown) => {
  store[key] = data;
});
const downloadJSON = mock((key: string) => store[key] ?? null);
const getLatestFileWithPrefix = mock((prefix: string) => {
  const keys = Object.keys(store)
    .filter((k) => k.startsWith(prefix))
    .sort();
  return keys.at(-1) ?? null;
});
const deleteObjectsWithPrefix = mock((prefix: string) => {
  deletedPrefixes.push(prefix);
  // Must be a real promise: BackupManager chains .catch() on it.
  return Promise.resolve({ deletedCount: 1 });
});
mockR2({ uploadJSON, downloadJSON, getLatestFileWithPrefix, deleteObjectsWithPrefix });

const { handleAdmin } = await import("@/routes/admin");
const { handleWebSocketUpgrade } = await import("@/routes/websocket");
const { BackupManager } = await import("@/managers/BackupManager");
const { globalManager } = await import("@/managers");
const { resetRegistryForTest } = await import("@/admin/registry");

const ORIGINAL_SECRET = process.env.OPERATOR_SECRET;
const SECRET = "op-test-secret";

function adminReq(path: string, method: string): [Request, URL] {
  const req = new Request(`http://localhost:8080${path}`, {
    method,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  return [req, new URL(req.url)];
}

const emptyRoomBackup = {
  clientDatas: [],
  globalVolume: 1,
  lowPassFreq: 20000,
  playlists: [],
};

describe("operator archive / delete", () => {
  beforeEach(() => {
    process.env.OPERATOR_SECRET = SECRET;
    store = {};
    deletedPrefixes = [];
    resetRegistryForTest();
    for (const id of globalManager.getRoomIds()) {
      globalManager.deleteRoom(id);
    }
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = ORIGINAL_SECRET;
  });

  it("archive evicts clients, persists the flag, hides the room, and rejects joins; unarchive reverses", async () => {
    const room = globalManager.getOrCreateRoom("100001");
    const ws = createMockWs({ clientId: "c1", roomId: "100001" });
    room.addClient(ws);

    const res = await handleAdmin(...adminReq("/admin/rooms/100001/archive", "POST"));
    expect(res.status).toBe(200);
    expect(room.isArchived()).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mock fn, no real `this`
    expect(ws.close).toHaveBeenCalled();
    expect(room.createBackup().archived).toBe(true);
    expect(globalManager.getActiveRooms().some((r) => r.roomId === "100001")).toBe(false);

    // New joins are rejected while archived. (Assert via the upgrade mock, not
    // the response status — websocketHandleClose.test.ts module-mocks
    // @/utils/responses suite-wide, which stubs errorResponse's status.)
    const joinReq = new Request("http://localhost:8080/ws?roomId=100001&username=u&clientId=c2");
    const upgrade = mock(() => true);
    const joinRes = handleWebSocketUpgrade(joinReq, { upgrade } as never);
    expect(joinRes).toBeInstanceOf(Response);
    expect(upgrade).not.toHaveBeenCalled();

    const res2 = await handleAdmin(...adminReq("/admin/rooms/100001/unarchive", "POST"));
    expect(res2.status).toBe(200);
    expect(room.isArchived()).toBe(false);
    expect(room.createBackup().archived).toBeUndefined();
  });

  it("archiving a nonexistent room 404s with an error body", async () => {
    const res = await handleAdmin(...adminReq("/admin/rooms/999999/archive", "POST"));
    expect(res.status).toBe(404);
  });

  it("delete evicts, purges R2 audio, drops the room, tombstones, and backs up", async () => {
    const room = globalManager.getOrCreateRoom("100002");
    const ws = createMockWs({ clientId: "c1", roomId: "100002" });
    room.addClient(ws);

    const res = await handleAdmin(...adminReq("/admin/rooms/100002", "DELETE"));
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mock fn, no real `this`
    expect(ws.close).toHaveBeenCalled();
    expect(deletedPrefixes).toContain("room-100002");
    expect(globalManager.getRoom("100002")).toBeUndefined();

    const registry = store["operator/registry.json"] as { tombstones: Record<string, number> };
    expect(registry.tombstones["100002"]).toBeNumber();

    // The post-delete backup no longer lists the room.
    const backupKey = Object.keys(store).find((k) => k.startsWith("state-backup/"))!;
    const backup = store[backupKey] as { data: { rooms: Record<string, unknown> } };
    expect(backup.data.rooms["100002"]).toBeUndefined();
  });

  it("restore skips a tombstoned room from an older backup and self-heals its audio", async () => {
    const deletedAt = Date.now();
    store["operator/registry.json"] = { tombstones: { "100003": deletedAt } };
    store["state-backup/backup-old.json"] = {
      timestamp: deletedAt - 60_000, // backup predates the delete
      data: { rooms: { "100003": emptyRoomBackup, "100004": emptyRoomBackup } },
    };

    expect(await BackupManager.restoreState()).toBe(true);
    expect(globalManager.getRoom("100003")).toBeUndefined();
    expect(globalManager.getRoom("100004")).toBeDefined();
    expect(deletedPrefixes).toContain("room-100003");
  });

  it("restores a re-created room whose backup is newer than its tombstone", async () => {
    const deletedAt = Date.now() - 120_000;
    store["operator/registry.json"] = { tombstones: { "100005": deletedAt } };
    store["state-backup/backup-new.json"] = {
      timestamp: Date.now(), // backup written AFTER the delete → legit re-creation
      data: { rooms: { "100005": emptyRoomBackup } },
    };

    expect(await BackupManager.restoreState()).toBe(true);
    expect(globalManager.getRoom("100005")).toBeDefined();
    expect(deletedPrefixes).not.toContain("room-100005");
  });

  it("purge requires ?confirm=all", async () => {
    globalManager.getOrCreateRoom("100010");
    const res = await handleAdmin(...adminReq("/admin/rooms", "DELETE"));
    expect(res.status).toBe(400);
    expect(globalManager.getRoom("100010")).toBeDefined();
  });

  it("purge wipes every room, sweeps orphaned audio, tombstones all, and backs up empty", async () => {
    globalManager.getOrCreateRoom("100011");
    globalManager.getOrCreateRoom("100012");

    const res = await handleAdmin(...adminReq("/admin/rooms?confirm=all", "DELETE"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purgedRooms: number };
    expect(body.purgedRooms).toBe(2);

    expect(globalManager.getRoomIds()).toHaveLength(0);
    expect(deletedPrefixes).toContain("room-100011");
    expect(deletedPrefixes).toContain("room-100012");
    expect(deletedPrefixes).toContain("room-"); // orphan sweep

    const registry = store["operator/registry.json"] as { tombstones: Record<string, number> };
    expect(Object.keys(registry.tombstones).sort()).toEqual(["100011", "100012"]);

    const backupKey = Object.keys(store).find((k) => k.startsWith("state-backup/"))!;
    const backup = store[backupKey] as { data: { rooms: Record<string, unknown> } };
    expect(Object.keys(backup.data.rooms)).toHaveLength(0);
  });

  it("restore preserves the archived flag", async () => {
    store["state-backup/backup-arch.json"] = {
      timestamp: Date.now(),
      data: { rooms: { "100006": { ...emptyRoomBackup, archived: true } } },
    };

    expect(await BackupManager.restoreState()).toBe(true);
    expect(globalManager.getRoom("100006")!.isArchived()).toBe(true);
  });
});
