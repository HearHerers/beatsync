// Operator (server-wide super-admin) authentication for /admin/* routes.
// See OPERATOR_ROOM_MANAGEMENT.md §4.1 (workspace root above this repo).
//
// Fail-closed: when OPERATOR_SECRET is unset, the operator surface does not
// exist — callers should return 404, not 401, so the routes don't advertise
// themselves. Never reuse CREATOR_SECRET or the demo ADMIN_SECRET here.

import { createHash, timingSafeEqual } from "node:crypto";

// Read at call time (not module load) so tests can set/unset the env var.
const operatorSecret = (): string => process.env.OPERATOR_SECRET ?? "";

export const operatorEnabled = (): boolean => operatorSecret().length > 0;

// Constant-time string comparison. Hashing both sides first gives equal-length
// buffers (timingSafeEqual requires that) without leaking the secret's length.
function timingSafeEqualStr(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

export function isOperator(req: Request): boolean {
  if (!operatorEnabled()) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token.length === 0) return false;
  return timingSafeEqualStr(token, operatorSecret());
}
