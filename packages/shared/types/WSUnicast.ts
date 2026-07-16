// 1:1 Private WS Responses
import { z } from "zod";
import { ScheduledActionSchema } from "./WSBroadcast";
import { SearchResponseSchema } from "./provider";

const NTPResponseMessageSchema = z.object({
  type: z.literal("NTP_RESPONSE"),
  t0: z.number(), // Client send timestamp (echoed back)
  t1: z.number(), // Server receive timestamp
  t2: z.number(), // Server send timestamp
  clientRTT: z.number().optional(), // Client's current RTT estimate in ms
  probeGroupId: z.number(), // Coded probes (Huygens): echoed from request
  probeGroupIndex: z.union([z.literal(0), z.literal(1)]), // Coded probes: echoed from request
});
export type NTPResponseMessageType = z.infer<typeof NTPResponseMessageSchema>;

export const MusicSearchResponseSchema = z.object({
  type: z.literal("SEARCH_RESPONSE"),
  // Echoes the request's query so the client can drop stale/out-of-order
  // responses during search-as-you-type (fast typing fires overlapping requests).
  query: z.string(),
  response: SearchResponseSchema,
});
export type MusicSearchResponseType = z.infer<typeof MusicSearchResponseSchema>;

// Sent privately to a client the server recognizes as the room's admin, so the
// client can persist the recoverable admin token (localStorage) and re-present
// it on future connects / share it to grant co-curator access.
export const SetAdminTokenSchema = z.object({
  type: z.literal("SET_ADMIN_TOKEN"),
  token: z.string(),
});
export type SetAdminTokenType = z.infer<typeof SetAdminTokenSchema>;

export const WSUnicastSchema = z.discriminatedUnion("type", [
  NTPResponseMessageSchema,
  ScheduledActionSchema,
  MusicSearchResponseSchema,
  SetAdminTokenSchema,
]);
export type WSUnicastType = z.infer<typeof WSUnicastSchema>;
