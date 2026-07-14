// Operator sub-router for /admin/*. Fail-closed: unauthorized or unknown
// requests get a bare 404 so the surface is invisible without the secret
// (see OPERATOR_ROOM_MANAGEMENT.md §4.1, workspace root above this repo).
//
// Deliberately no CORS headers here (unlike jsonResponse/errorResponse):
// operator calls are same-origin or non-browser clients sending the bearer.
//
// Current endpoints (Phase 3 of the operator plan will grow this):
//
//   POST /admin/backup — write a fresh state backup to R2 now, so offline
//   tooling (bun run rooms:list --sync) can read current state instead of
//   waiting out the 60s periodic backup interval.

import { isOperator } from "@/admin/auth";
import { IS_DEMO_MODE } from "@/demo";
import { BackupManager } from "@/managers/BackupManager";
import { globalManager } from "@/managers";

const invisible = () => new Response("Not found", { status: 404 });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function handleAdmin(req: Request, url: URL): Promise<Response> {
  if (IS_DEMO_MODE || !isOperator(req)) return invisible();

  if (req.method === "POST" && url.pathname === "/admin/backup") {
    await BackupManager.backupState();
    let rooms = 0;
    globalManager.forEachRoom(() => rooms++);
    console.log(`🛠️ Operator triggered an on-demand state backup (${rooms} room(s)).`);
    return json({ ok: true, rooms });
  }

  return invisible();
}
