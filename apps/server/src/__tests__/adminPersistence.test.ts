import { beforeEach, describe, expect, it } from "bun:test";
import { mockR2 } from "@/__tests__/mocks/r2";
import { createMockWs } from "@/__tests__/mocks/websocket";
import { globalManager } from "@/managers/GlobalManager";
import type { RoomManager } from "@/managers/RoomManager";

mockR2();

describe("Admin Persistence", () => {
  let room: RoomManager;
  const roomId = "test-room";

  beforeEach(() => {
    // Clear all rooms before each test
    const roomIds = globalManager.getRoomIds();
    for (const id of roomIds) {
      globalManager.deleteRoom(id);
    }
    // Create a fresh room for each test
    room = globalManager.getOrCreateRoom(roomId);
  });

  it("should make the first person who joins an admin", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "user1", roomId: roomId });

    room.addClient(ws1);

    const clients = room.getClients();
    expect(clients.length).toBe(1);
    expect(clients[0].isAdmin).toBe(true);
    expect(clients[0].clientId).toBe("client-1");
  });

  it("does NOT promote a random client when the only admin leaves (no hijack)", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "admin-user", roomId: roomId });
    const ws2 = createMockWs({ clientId: "client-2", username: "user2", roomId: roomId });
    const ws3 = createMockWs({ clientId: "client-3", username: "user3", roomId: roomId });

    // Add clients in order
    room.addClient(ws1); // Admin (first connector + mints token)
    room.addClient(ws2);
    room.addClient(ws3);

    // Verify initial state
    let clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(false);
    expect(clients.find((c) => c.clientId === "client-3")?.isAdmin).toBe(false);

    // Admin leaves
    room.removeClient("client-1");

    // Admin is a recoverable token now — remaining clients stay listeners.
    clients = room.getClients();
    expect(clients.length).toBe(2);
    expect(clients.every((c) => !c.isAdmin)).toBe(true);
  });

  it("grants admin to a client presenting the room's admin token", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "creator", roomId: roomId });
    room.addClient(ws1); // creator becomes admin and mints the token

    const token = room.getAdminToken();
    expect(token).toBeTruthy();
    expect(room.getClient("client-1")?.isAdmin).toBe(true);

    // A different client presenting the token becomes a co-curator (admin).
    const ws2 = createMockWs({ clientId: "client-2", username: "sweetie", roomId: roomId, roomAdminToken: token });
    room.addClient(ws2);
    expect(room.getClient("client-2")?.isAdmin).toBe(true);

    // A client without the token is a listener.
    const ws3 = createMockWs({ clientId: "client-3", username: "guest", roomId: roomId });
    room.addClient(ws3);
    expect(room.getClient("client-3")?.isAdmin).toBe(false);
  });

  it("should preserve admin status and username when client rejoins with same ID", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "admin-user", roomId: roomId });
    const ws2 = createMockWs({ clientId: "client-2", username: "user2", roomId: roomId });

    // Setup: admin and another user
    room.addClient(ws1);
    room.addClient(ws2);

    // Verify initial state
    let clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-1")?.username).toBe("admin-user");

    // Admin disconnects — no random promotion, client-2 stays a listener.
    room.removeClient("client-1");
    clients = room.getClients();
    expect(clients.length).toBe(1);
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(false);

    // Original admin rejoins with same clientId — admin restored from cache.
    const ws1Reconnect = createMockWs({ clientId: "client-1", username: "admin-user", roomId: roomId });
    room.addClient(ws1Reconnect);

    clients = room.getClients();
    expect(clients.length).toBe(2);
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-1")?.username).toBe("admin-user");
    // Client-2 remains a listener — admin isn't handed out on disconnect.
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(false);
  });

  it("should keep non-admin as non-admin when rejoining", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "admin", roomId: roomId });
    const ws2 = createMockWs({ clientId: "client-2", username: "regular-user", roomId: roomId });

    // Setup: admin and regular user
    room.addClient(ws1);
    room.addClient(ws2);

    // Verify initial state
    let clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(false);

    // Non-admin disconnects and reconnects
    room.removeClient("client-2");

    const ws2Reconnect = createMockWs({ clientId: "client-2", username: "regular-user", roomId: roomId });
    room.addClient(ws2Reconnect);

    // Verify they're still not admin
    clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(false);
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
  });

  it("should handle multiple admins correctly", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "admin1", roomId: roomId });
    const ws2 = createMockWs({ clientId: "client-2", username: "user2", roomId: roomId });
    const ws3 = createMockWs({ clientId: "client-3", username: "user3", roomId: roomId });

    // Setup: one admin, two regular users
    room.addClient(ws1);
    room.addClient(ws2);
    room.addClient(ws3);

    // Manually promote client-2 to admin (simulating SET_ADMIN command)
    room.setAdmin({ targetClientId: "client-2", isAdmin: true });

    // Verify we have two admins
    let clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-3")?.isAdmin).toBe(false);

    // One admin leaves
    room.removeClient("client-1");

    // Verify the other admin remains admin, no promotion needed
    clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-3")?.isAdmin).toBe(false);

    // Original admin rejoins
    const ws1Reconnect = createMockWs({ clientId: "client-1", username: "admin1", roomId: roomId });
    room.addClient(ws1Reconnect);

    // Both should be admins again
    clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(true);
  });

  it("lets the original admin reclaim admin on rejoin (no one else is promoted)", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "original-admin", roomId: roomId });
    const ws2 = createMockWs({ clientId: "client-2", username: "user2", roomId: roomId });

    // Setup: admin and regular user
    room.addClient(ws1);
    room.addClient(ws2);

    // Admin leaves — user2 is NOT promoted (admin is a recoverable token now).
    room.removeClient("client-1");
    let clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(false);

    // Original admin returns and reclaims admin from cache.
    const ws1Reconnect = createMockWs({ clientId: "client-1", username: "original-admin", roomId: roomId });
    room.addClient(ws1Reconnect);

    clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-2")?.isAdmin).toBe(false);
  });

  it("should preserve client data even without active connection", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "user1", roomId: roomId });

    room.addClient(ws1);

    // Get the client data directly (bypassing getClients which filters by connection)
    const client = room.getClient("client-1");
    expect(client).toBeDefined();
    expect(client?.isAdmin).toBe(true);

    // Remove client (only removes from wsConnections now)
    room.removeClient("client-1");

    // Client data should still exist
    const clientAfterRemoval = room.getClient("client-1");
    expect(clientAfterRemoval).toBeDefined();
    expect(clientAfterRemoval?.isAdmin).toBe(true);

    // But getClients should return empty (no active connections)
    const activeClients = room.getClients();
    expect(activeClients.length).toBe(0);
  });

  it("should not auto-promote new joiners when cached admin data exists", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "user1", roomId: roomId });
    const ws2 = createMockWs({ clientId: "client-2", username: "user2", roomId: roomId });

    // Add and remove all clients
    room.addClient(ws1);
    room.addClient(ws2);
    room.removeClient("client-1");
    room.removeClient("client-2");

    // Room has no active connections, but clientData is preserved for rejoin
    expect(room.getClients().length).toBe(0);

    // New client (no cached data) joins — should NOT be auto-promoted, because
    // the original admin's cached data is still there and they may reclaim it.
    const ws3 = createMockWs({ clientId: "client-3", username: "user3", roomId: roomId });
    room.addClient(ws3);

    let clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-3")?.isAdmin).toBe(false);

    // Original admin rejoins and reclaims admin status from cache
    const ws1Reconnect = createMockWs({ clientId: "client-1", username: "user1", roomId: roomId });
    room.addClient(ws1Reconnect);

    clients = room.getClients();
    expect(clients.find((c) => c.clientId === "client-1")?.isAdmin).toBe(true);
    expect(clients.find((c) => c.clientId === "client-3")?.isAdmin).toBe(false);
  });

  it("should preserve old username if it changes on rejoin", () => {
    const ws1 = createMockWs({ clientId: "client-1", username: "original-name", roomId: roomId });

    room.addClient(ws1);

    let clients = room.getClients();
    expect(clients[0].username).toBe("original-name");

    // Disconnect and rejoin with different username
    room.removeClient("client-1");

    const ws1NewName = createMockWs({ clientId: "client-1", username: "new-name", roomId: roomId });
    room.addClient(ws1NewName);

    clients = room.getClients();
    expect(clients[0].username).toBe("original-name"); // Should still be the old name
    expect(clients[0].clientId).toBe("client-1");
    expect(clients[0].isAdmin).toBe(true); // Admin status preserved
  });
});
