import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mockR2 } from "./mocks/r2";

const uploadJSON = mock(() => {
  /* noop */
});
mockR2({ uploadJSON });

const { handleAdmin } = await import("@/routes/admin");

const ORIGINAL_SECRET = process.env.OPERATOR_SECRET;

function request(path: string, token?: string, method = "POST"): [Request, URL] {
  const req = new Request(`http://localhost:8080${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return [req, new URL(req.url)];
}

describe("POST /admin/backup", () => {
  beforeEach(() => {
    delete process.env.OPERATOR_SECRET;
    uploadJSON.mockClear();
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = ORIGINAL_SECRET;
  });

  it("is invisible (404) when OPERATOR_SECRET is unset, even with a token", async () => {
    const res = await handleAdmin(...request("/admin/backup", "anything"));
    expect(res.status).toBe(404);
    expect(uploadJSON).not.toHaveBeenCalled();
  });

  it("is invisible (404) without or with a wrong bearer token", async () => {
    process.env.OPERATOR_SECRET = "s3cret";
    expect((await handleAdmin(...request("/admin/backup"))).status).toBe(404);
    expect((await handleAdmin(...request("/admin/backup", "wrong"))).status).toBe(404);
    expect(uploadJSON).not.toHaveBeenCalled();
  });

  it("writes a backup and reports room count with the correct token", async () => {
    process.env.OPERATOR_SECRET = "s3cret";
    const res = await handleAdmin(...request("/admin/backup", "s3cret"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rooms: number };
    expect(body.ok).toBe(true);
    expect(typeof body.rooms).toBe("number");
    expect(uploadJSON).toHaveBeenCalledTimes(1);
  });

  it("404s unknown /admin paths and non-POST methods even when authorized", async () => {
    process.env.OPERATOR_SECRET = "s3cret";
    expect((await handleAdmin(...request("/admin/nope", "s3cret"))).status).toBe(404);
    expect((await handleAdmin(...request("/admin/backup", "s3cret", "GET"))).status).toBe(404);
    expect(uploadJSON).not.toHaveBeenCalled();
  });
});
