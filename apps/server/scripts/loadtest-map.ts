/**
 * hearhere Map-Room Load Test — simulates a crowd arriving at a map room.
 *
 * WHY THIS EXISTS (read before tuning anything):
 * A live event failed in a way that looked exactly like the object store dying,
 * and wasn't. nginx's rate limiter is evaluated BEFORE its cache, and it keys on
 * client IP — so when every listener arrives through one NAT (or one tunnel, and
 * therefore one loopback address) they share a single token bucket. Requests were
 * refused in bulk, with 503s in the log, while storage sat idle. 5,636 refusals in
 * one evening, ~90% of them nginx's own.
 *
 * A load test that only measures "did the bytes arrive" would have missed that
 * entirely. So this reports WHY requests failed, not just how many: it separates
 * throttling (429 / nginx 503) from storage errors (MinIO 503 XML) from timeouts,
 * tracks cache hit rate, and tells you whether you are bandwidth-bound or
 * request-bound. That distinction is the whole point.
 *
 * WHAT IT SIMULATES
 * Each virtual listener does what a real phone does in a map room:
 *   1. WebSocket connect (roomId/username/clientId, roomType=map)
 *   2. NTP probe pairs, then steady-state pings (the server evicts clients that
 *      go quiet for ~4.5s, so this also keeps the connection alive)
 *   3. Learns zones + their playlists from SHAPES_UPDATE / PLAYLISTS_UPDATE
 *   4. Downloads zone audio straight from S3/MinIO — the real load, and the part
 *      that never touches the app server
 *   5. Reports AUDIO_SOURCE_LOADED, then keeps the socket alive
 *
 * IMPORTANT — WHERE YOU RUN THIS CHANGES WHAT IT TESTS:
 *   localhost / one machine  -> every virtual listener shares ONE source IP, so
 *                               you are testing the "whole crowd in one rate-limit
 *                               bucket" case. This is what a venue behind one NAT,
 *                               or any host behind a tunnel, actually looks like.
 *   several machines         -> distinct source IPs, i.e. per-IP limits behaving
 *                               as intended. Run the same command on each box with
 *                               a different --label and add the results up.
 * Both are worth testing. They fail differently, and the first is the one that
 * bit us.
 *
 * USAGE
 *   # pure S3/CDN load — no app server needed, reproduces the party failure
 *   bun run scripts/loadtest-map.ts --audio-only --users 20 \
 *       --urls-file /tmp/tracks.txt
 *
 *   # full client simulation against a live room
 *   bun run scripts/loadtest-map.ts --room 523841 --users 20 \
 *       --ws wss://ws.cyrus-dev.hearhere.now/ws
 *
 *   # build a disposable test room out of audio already in the bucket
 *   bun run scripts/loadtest-map.ts --seed --room 990001 --zones 14 \
 *       --tracks-per-zone 3 --urls-file /tmp/tracks.txt \
 *       --ws wss://ws.cyrus-dev.hearhere.now/ws
 *
 * Generate a URL list on the MinIO host:
 *   sudo find /var/lib/hearhere-minio/data/beatsync-audio/room-523841 \
 *        -mindepth 1 -maxdepth 1 -type d -name '*.mp3' -printf '%f\0' \
 *     | python3 -c "import sys,urllib.parse as u; [print('https://s3.example.com/beatsync-audio/room-523841/'+u.quote(k)) for k in sys.stdin.read().split(chr(0)) if k]" \
 *     > /tmp/tracks.txt
 *
 * OPTIONS
 *   --users <n>            virtual listeners (default 20)
 *   --room <id>            room to join / seed (default 990001)
 *   --ws <url>             websocket endpoint, e.g. wss://ws.host/ws
 *   --behavior <mode>      preload | wander | enter   (default preload)
 *                            preload = everyone pulls every zone at once (worst case,
 *                                      and what the Preload button actually does)
 *                            wander  = walk between zones, pulling on entry
 *                            enter   = pull one zone's track and stop
 *   --ramp <ms>            stagger arrivals over this window (default 5000; 0 = all at once)
 *   --duration <s>         keep sockets alive this long after loading (default 30)
 *   --audio-only           skip the app server entirely; just fetch audio
 *   --urls-file <path>     newline-delimited track URLs (required for --audio-only/--seed)
 *   --seed                 create a test map room instead of load testing
 *   --zones <n>            (--seed) zones to create (default 14)
 *   --tracks-per-zone <n>  (--seed) tracks per zone (default 3)
 *   --timeout <s>          per-request timeout (default 60)
 *   --label <str>          tag for this run, useful when aggregating across machines
 *   --json <path>          also write raw per-request results here
 */

import { randomUUID } from "crypto";

// ── args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};
const flag = (n: string) => args.includes(`--${n}`);

const USERS = parseInt(arg("users", "20"));
const ROOM_ID = arg("room", "990001");
const WS_URL = arg("ws", "ws://localhost:8080/ws");
const BEHAVIOR = arg("behavior", "preload") as "preload" | "wander" | "enter";
const RAMP_MS = parseInt(arg("ramp", "5000"));
const DURATION_S = parseInt(arg("duration", "30"));
const AUDIO_ONLY = flag("audio-only");
const SEED = flag("seed");
const URLS_FILE = arg("urls-file", "");
const ZONES = parseInt(arg("zones", "14"));
const TRACKS_PER_ZONE = parseInt(arg("tracks-per-zone", "3"));
const TIMEOUT_MS = parseInt(arg("timeout", "60")) * 1000;
const LABEL = arg("label", "");
const JSON_OUT = arg("json", "");

if (flag("help") || flag("h")) {
  console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
  process.exit(0);
}

// ── result recording ────────────────────────────────────────────────
interface Req {
  t: number; // ms since start, when the request began
  status: number; // 0 = transport error/timeout
  cache: string; // X-Cache-Status, "-" when absent
  bytes: number;
  ttfb: number; // ms to response headers
  total: number; // ms to last byte
  err?: string;
  user: number;
}
const reqs: Req[] = [];
const wsStats = { connected: 0, failed: 0, closedEarly: 0, ntpSent: 0, ntpRecv: 0, rttSum: 0 };
const START = Date.now();

// ── audio fetch ─────────────────────────────────────────────────────
/**
 * Fetch one track the way a client does: whole file, no Range, and read the body
 * to completion so the bytes genuinely cross the network. The body is streamed and
 * discarded rather than buffered — at 10MB/track and dozens of concurrent users,
 * holding them would measure our own memory pressure instead of the server's.
 */
async function fetchTrack(url: string, user: number): Promise<Req> {
  const began = Date.now();
  const rec: Req = { t: began - START, status: 0, cache: "-", bytes: 0, ttfb: 0, total: 0, user };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Origin: new URL(url).origin.replace("s3.", "") },
    });
    rec.ttfb = Date.now() - began;
    rec.status = res.status;
    rec.cache = res.headers.get("x-cache-status") ?? "-";
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rec.bytes += value.byteLength;
      }
    }
    rec.total = Date.now() - began;
  } catch (e: any) {
    rec.total = Date.now() - began;
    rec.err = e?.name === "AbortError" ? "timeout" : String(e?.message ?? e).slice(0, 80);
  } finally {
    clearTimeout(timer);
  }
  reqs.push(rec);
  return rec;
}

// ── websocket client ────────────────────────────────────────────────
interface Zone {
  id: string;
  tracks: string[];
}

/** One simulated listener. Resolves when its work is done (or duration elapses). */
async function runUser(idx: number, until: number): Promise<void> {
  const clientId = randomUUID();
  const username = `load${idx}`;
  const url = `${WS_URL}?roomId=${ROOM_ID}&username=${username}&clientId=${clientId}&roomType=map`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    wsStats.failed++;
    return;
  }

  const zones = new Map<string, Zone>();
  let opened = false;
  let ntpTimer: ReturnType<typeof setInterval> | undefined;
  const pending = new Set<Promise<unknown>>();

  const send = (o: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  };

  // Declared before the handlers that close over them: onmessage fires only after
  // this function's synchronous body finishes, but relying on that is a trap for
  // the next person to move code around.
  let started = false;
  let behave: () => Promise<void> = async () => {};

  const ntp = (() => {
    let group = 0;
    return () => {
      // Coded probe pair, matching the real client. Also serves as the keepalive:
      // the server evicts clients silent for ~4.5s.
      group++;
      for (const i of [0, 1] as const) {
        wsStats.ntpSent++;
        send({ type: "NTP_REQUEST", t0: Date.now(), probeGroupId: group, probeGroupIndex: i });
      }
    };
  })();

  await new Promise<void>((resolve) => {
    const done = () => {
      if (ntpTimer) clearInterval(ntpTimer);
      try {
        ws.close();
      } catch {}
      resolve();
    };

    ws.onopen = () => {
      opened = true;
      wsStats.connected++;
      send({ type: "SYNC" });
      ntp();
      ntpTimer = setInterval(ntp, 2500);
    };

    ws.onerror = () => {
      if (!opened) wsStats.failed++;
    };

    ws.onclose = () => {
      if (opened && Date.now() < until) wsStats.closedEarly++;
      done();
    };

    ws.onmessage = async (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }

      // Room broadcasts arrive wrapped: {type:"ROOM_EVENT", event:{type:"PLAYLISTS_UPDATE",...}}.
      // Unicasts (NTP_RESPONSE) are not wrapped, so unwrap only when present and
      // switch on the inner type either way.
      const body = msg.type === "ROOM_EVENT" && msg.event ? msg.event : msg;

      if (body.type === "NTP_RESPONSE") {
        wsStats.ntpRecv++;
        if (typeof body.t0 === "number") wsStats.rttSum += Date.now() - body.t0;
        return;
      }

      if (body.type === "PLAYLISTS_UPDATE" && Array.isArray(body.playlists)) {
        for (const p of body.playlists) {
          if (p?.id && p.id !== "main" && Array.isArray(p.tracks) && p.tracks.length) {
            zones.set(p.id, { id: p.id, tracks: p.tracks.map((t: any) => t.url).filter(Boolean) });
          }
        }
        // First full picture of the room: start behaving like a listener.
        if (zones.size && !started) {
          started = true;
          const p = behave();
          pending.add(p);
          p.finally(() => pending.delete(p));
        }
        return;
      }

      // The server asks clients to load a track before scheduling play; a real
      // client downloads then acknowledges, and the server waits on that ack.
      if (body.type === "LOAD_AUDIO_SOURCE" && body.audioSourceToPlay?.url) {
        const u = body.audioSourceToPlay.url;
        const p = fetchTrack(u, idx).then(() =>
          send({ type: "AUDIO_SOURCE_LOADED", source: { url: u } })
        );
        pending.add(p);
        p.finally(() => pending.delete(p));
      }
    };

    behave = async () => {
      const list = [...zones.values()];
      if (!list.length) return;

      if (BEHAVIOR === "preload") {
        // Everyone pulls every zone at once — the Preload button, and the worst
        // realistic burst the system will ever see.
        await Promise.all(
          list.flatMap((z) =>
            z.tracks.slice(0, 1).map(async (u) => {
              await fetchTrack(u, idx);
              send({ type: "AUDIO_SOURCE_LOADED", source: { url: u } });
            })
          )
        );
      } else if (BEHAVIOR === "enter") {
        const z = list[idx % list.length];
        if (z.tracks[0]) {
          await fetchTrack(z.tracks[0], idx);
          send({ type: "AUDIO_SOURCE_LOADED", source: { url: z.tracks[0] } });
        }
      } else {
        // wander: move between zones, pulling each on entry, until time runs out.
        let i = idx % list.length;
        while (Date.now() < until) {
          const z = list[i % list.length];
          send({ type: "SET_GEO_POSITION", lat: 42.28 + Math.random() * 0.01, lng: -83.74 + Math.random() * 0.01 });
          if (z.tracks[0]) {
            await fetchTrack(z.tracks[0], idx);
            send({ type: "AUDIO_SOURCE_LOADED", source: { url: z.tracks[0] } });
          }
          i++;
          await sleep(3000 + Math.random() * 4000);
        }
      }
    };

    // Hard stop so a stalled socket can't hang the run.
    setTimeout(async () => {
      await Promise.allSettled([...pending]);
      done();
    }, Math.max(0, until - Date.now()));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── audio-only mode ─────────────────────────────────────────────────
async function runAudioOnly(urls: string[], until: number) {
  await Promise.all(
    Array.from({ length: USERS }, async (_, u) => {
      await sleep((RAMP_MS / Math.max(1, USERS)) * u);
      if (BEHAVIOR === "preload") {
        // Each user pulls the whole set, concurrently — mirrors every phone
        // preloading every zone the moment they arrive.
        await Promise.all(urls.map((url) => fetchTrack(url, u)));
      } else {
        let i = u;
        do {
          await fetchTrack(urls[i % urls.length], u);
          i++;
          if (BEHAVIOR === "enter") break;
          await sleep(2000);
        } while (Date.now() < until);
      }
    })
  );
}

// ── seed a disposable test room ─────────────────────────────────────
async function seedRoom(urls: string[]) {
  console.log(`seeding room ${ROOM_ID}: ${ZONES} zones x ${TRACKS_PER_ZONE} tracks`);
  const clientId = randomUUID();
  const ws = new WebSocket(`${WS_URL}?roomId=${ROOM_ID}&username=seeder&clientId=${clientId}&roomType=map`);
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => reject(new Error("seed: websocket failed"));
    ws.onopen = () => resolve();
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));

  for (let z = 0; z < ZONES; z++) {
    const id = `loadtest-zone-${z}`;
    // Small circles laid out in a row; geometry only matters in that clients can
    // be inside one, so keep them far enough apart not to overlap.
    send({
      type: "ADD_SHAPE",
      shape: {
        id,
        type: "circle",
        coordinates: { center: { lat: 42.28 + z * 0.002, lng: -83.74 }, radius: 60 },
        createdBy: clientId,
        createdAt: Date.now(),
        name: `Load Zone ${z}`,
        groupId: null,
        falloffMeters: 20,
      },
    });
    await sleep(60);
    const slice = urls.slice((z * TRACKS_PER_ZONE) % urls.length).slice(0, TRACKS_PER_ZONE);
    if (slice.length) {
      send({ type: "IMPORT_TRACKS_TO_CONTEXT", urls: slice, contextId: id });
      await sleep(120);
    }
  }
  await sleep(1500);
  ws.close();
  console.log(`seeded. now run:  bun run scripts/loadtest-map.ts --room ${ROOM_ID} --users ${USERS} --ws ${WS_URL}`);
}

// ── reporting ───────────────────────────────────────────────────────
const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
};

function report(elapsedMs: number) {
  const n = reqs.length;
  console.log("\n" + "=".repeat(72));
  console.log(` load test report${LABEL ? "  [" + LABEL + "]" : ""}`);
  console.log("=".repeat(72));
  console.log(`  users=${USERS}  behavior=${BEHAVIOR}  mode=${AUDIO_ONLY ? "audio-only" : "full"}`);
  console.log(`  wall clock: ${(elapsedMs / 1000).toFixed(1)}s   requests: ${n}`);

  if (!AUDIO_ONLY) {
    const avgRtt = wsStats.ntpRecv ? wsStats.rttSum / wsStats.ntpRecv : 0;
    console.log(
      `\n  websocket: ${wsStats.connected} connected, ${wsStats.failed} failed, ` +
        `${wsStats.closedEarly} dropped early  |  NTP ${wsStats.ntpRecv}/${wsStats.ntpSent} answered, avg RTT ${avgRtt.toFixed(0)}ms`
    );
    if (wsStats.closedEarly)
      console.log(`    ^ dropped-early is a real symptom: the server evicts clients that go quiet,`);
    if (wsStats.closedEarly)
      console.log(`      and a saturated uplink starves the keepalive. Matches "clients randomly refresh".`);
  }

  if (!n) {
    console.log("\n  no audio requests were made — nothing to measure.");
    return;
  }

  // ---- status breakdown, classified by CAUSE ----
  const byStatus = new Map<number, number>();
  for (const r of reqs) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const ok = reqs.filter((r) => r.status === 200 || r.status === 206).length;
  const throttled = (byStatus.get(429) ?? 0) + (byStatus.get(503) ?? 0);
  const timeouts = reqs.filter((r) => r.err === "timeout").length;
  const transport = reqs.filter((r) => r.status === 0 && r.err !== "timeout").length;

  console.log(`\n  outcomes:`);
  for (const [s, c] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    const pctv = ((c / n) * 100).toFixed(1);
    const note =
      s === 200 || s === 206
        ? "ok"
        : s === 429
        ? "RATE LIMITED (nginx refused before reaching storage)"
        : s === 503
        ? "unavailable — could be nginx throttling OR the object store"
        : s === 0
        ? "transport error / timeout"
        : "";
    console.log(`    ${s === 0 ? "err" : s}  ${String(c).padStart(6)}  ${pctv.padStart(5)}%   ${note}`);
  }
  if (timeouts) console.log(`    (${timeouts} of the errors were timeouts at ${TIMEOUT_MS / 1000}s)`);

  // ---- cache ----
  // Only requests that actually reached the cache. A throttled request is
  // rejected before the cache lookup, so counting its absent header as a cache
  // outcome would understate the hit rate and hide why it failed.
  const byCache = new Map<string, number>();
  for (const r of reqs) {
    if (r.status !== 200 && r.status !== 206) continue;
    byCache.set(r.cache, (byCache.get(r.cache) ?? 0) + 1);
  }
  if ([...byCache.keys()].some((k) => k !== "-")) {
    const hits = byCache.get("HIT") ?? 0;
    const miss = byCache.get("MISS") ?? 0;
    console.log(
      `\n  cache: ` +
        [...byCache].map(([k, v]) => `${k}=${v}`).join("  ") +
        (hits + miss ? `   hit rate ${((hits / (hits + miss)) * 100).toFixed(0)}%` : "")
    );
  } else {
    console.log(`\n  cache: no X-Cache-Status header — no proxy cache in front of storage`);
  }

  // ---- bandwidth ----
  const bytes = reqs.reduce((a, r) => a + r.bytes, 0);
  const gb = bytes / 1e9;
  const mbps = (bytes * 8) / 1e6 / (elapsedMs / 1000);
  console.log(
    `\n  transferred: ${gb.toFixed(2)} GB in ${(elapsedMs / 1000).toFixed(1)}s ` +
      `= ${mbps.toFixed(1)} Mbit/s average (${(bytes / 1e6 / (elapsedMs / 1000)).toFixed(1)} MB/s)`
  );

  // ---- latency ----
  const good = reqs.filter((r) => r.status === 200 || r.status === 206);
  if (good.length) {
    const tt = good.map((r) => r.ttfb);
    const tot = good.map((r) => r.total);
    console.log(
      `  time to first byte: p50 ${pct(tt, 50)}ms  p95 ${pct(tt, 95)}ms  p99 ${pct(tt, 99)}ms\n` +
        `  full download:      p50 ${(pct(tot, 50) / 1000).toFixed(1)}s  p95 ${(pct(tot, 95) / 1000).toFixed(1)}s  p99 ${(pct(tot, 99) / 1000).toFixed(1)}s`
    );
  }

  // ---- timeline: when did it break? ----
  const secs = Math.ceil(elapsedMs / 1000);
  if (secs > 1 && secs < 600) {
    const okS = new Array(secs).fill(0);
    const badS = new Array(secs).fill(0);
    for (const r of reqs) {
      const s = Math.min(secs - 1, Math.floor(r.t / 1000));
      if (r.status === 200 || r.status === 206) okS[s]++;
      else badS[s]++;
    }
    const peak = Math.max(...okS.map((v, i) => v + badS[i]), 1);
    console.log(`\n  per-second timeline (o = ok, X = failed; peak ${peak}/s):`);
    for (let s = 0; s < secs; s++) {
      if (!okS[s] && !badS[s]) continue;
      const w = 44;
      const bar = "o".repeat(Math.round((okS[s] / peak) * w)) + "X".repeat(Math.round((badS[s] / peak) * w));
      // (widths are fractions of the busiest second's TOTAL, so bars stay <= w)
      console.log(`    ${String(s).padStart(4)}s ${String(okS[s]).padStart(4)}/${String(badS[s]).padStart(4)} ${bar}`);
    }
  }

  // ---- verdict ----
  console.log(`\n  ${"-".repeat(68)}`);
  console.log("  VERDICT");
  const failRate = ((n - ok) / n) * 100;
  if (throttled > 0) {
    console.log(`    THROTTLED: ${throttled} request(s) refused with 429/503.`);
    console.log(`    This is a REQUEST-RATE ceiling, not a bandwidth or storage one.`);
    console.log(`    On the server check which it was — a rejection never reaches storage:`);
    console.log(`      grep "limiting requests" /var/log/nginx/error.log | tail`);
    console.log(`    If it is nginx, raise the audio read zone's rate/burst, and confirm`);
    console.log(`    nginx sees real client IPs (all-one-address => one shared bucket).`);
  } else if (timeouts + transport > 0) {
    console.log(`    ${timeouts + transport} request(s) failed without an HTTP status.`);
    console.log(`    Typically saturation: the uplink is full and connections stall out.`);
    console.log(`    Compare the Mbit/s above against the origin's real upload capacity.`);
  } else if (failRate === 0) {
    console.log(`    All ${n} requests succeeded at ${USERS} users.`);
    console.log(`    Re-run with more --users, or --ramp 0, until something gives.`);
  }
  const perUser = bytes / USERS / 1e6;
  console.log(
    `\n    Each listener pulled ${perUser.toFixed(0)} MB. Twenty would move ` +
      `${((perUser * 20) / 1000).toFixed(1)} GB,\n    fifty would move ${((perUser * 50) / 1000).toFixed(1)} GB — all of it across the origin's uplink,` +
      `\n    which no amount of caching in front of storage reduces.`
  );
  if (!AUDIO_ONLY && wsStats.connected < USERS)
    console.log(`\n    NOTE: only ${wsStats.connected}/${USERS} sockets connected — check the app server too.`);
  console.log("  " + "-".repeat(68));

  if (JSON_OUT) {
    require("fs").writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, users: USERS, elapsedMs, reqs }, null, 2));
    console.log(`\n  raw results -> ${JSON_OUT}`);
  }
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  let urls: string[] = [];
  if (URLS_FILE) {
    urls = require("fs")
      .readFileSync(URLS_FILE, "utf8")
      .split("\n")
      .map((s: string) => s.trim())
      .filter((s: string) => s.startsWith("http"));
    if (!urls.length) {
      console.error(`no usable URLs in ${URLS_FILE}`);
      process.exit(1);
    }
  }

  if (SEED) {
    if (!urls.length) {
      console.error("--seed needs --urls-file (tracks must already exist in the bucket)");
      process.exit(1);
    }
    await seedRoom(urls);
    return;
  }

  if (AUDIO_ONLY && !urls.length) {
    console.error("--audio-only needs --urls-file (see the header for a one-liner to build it)");
    process.exit(1);
  }

  const until = Date.now() + RAMP_MS + DURATION_S * 1000;
  console.log(
    `starting ${USERS} listener(s), behavior=${BEHAVIOR}, ramp=${RAMP_MS}ms, ` +
      `then holding ${DURATION_S}s\n` +
      (AUDIO_ONLY ? `audio-only against ${urls.length} track URL(s)` : `room ${ROOM_ID} via ${WS_URL}`)
  );

  const t0 = Date.now();
  if (AUDIO_ONLY) {
    await runAudioOnly(urls, until);
  } else {
    await Promise.all(
      Array.from({ length: USERS }, async (_, i) => {
        await sleep((RAMP_MS / Math.max(1, USERS)) * i);
        await runUser(i, until);
      })
    );
  }
  report(Date.now() - t0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
