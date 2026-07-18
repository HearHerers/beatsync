// Per-shape Web Audio engine for map rooms. Each shape gets one
// AudioBufferSourceNode → proximityGain → masterGain → destination chain.
//
// Scheduling math + buffer loading delegate to globalStore so map rooms inherit
// beatsync's NTP offset, output-latency compensation, and decode pipeline exactly —
// the only thing we add on top is per-shape storage (multiple parallel chains).

import { audioContextManager } from "@/lib/audioContextManager";
import { extractFileNameFromUrl } from "@/lib/utils";
import { computeScheduleTiming, downloadBufferFromURL, useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { sendWSRequest } from "@/utils/ws";
import { epochNow, ClientActionEnum, MAIN_CONTEXT_ID, MAP_CONSTANTS } from "@beatsync/shared";
import { toast } from "sonner";

// Minimum lead time we want between calling source.start() and the audio thread
// actually starting playback. Below this, start() is racy and tabs drift by a few ms
// from each other. Mirrors the 50ms threshold beatsync's schedulePlay uses.
const MIN_SCHEDULE_LEAD_MS = 50;
// When we're genuinely late (network/decode), how much extra delay to ask the audio
// thread for so the start lands sample-accurately. The buffer offset is advanced by
// the same amount so the playback position still tracks the server's timeline.
const LATE_RETRY_DELAY_MS = 250;
// Pause before the single download/decode retry, so a transient network or
// storage hiccup has a moment to clear before we re-request the same URL.
const DOWNLOAD_RETRY_DELAY_MS = 1000;

// Track name for user-facing errors. extractFileNameFromUrl strips the R2
// timestamp suffix but throws on URLs without a path segment — fall back to
// the raw URL rather than crash an error path.
function trackNameFromUrl(url: string): string {
  try {
    return extractFileNameFromUrl(url);
  } catch {
    return url;
  }
}

interface ShapeChain {
  buffer?: AudioBuffer;
  bufferPromise?: Promise<AudioBuffer>; // in-flight decode for the current URL
  url?: string; // URL the CURRENT buffer was actually decoded from — set only once decode completes
  requestedUrl?: string; // latest URL asked for; leads `url` while a decode is in flight
  // Live download progress (bytes) of the in-flight fetch. Present only while
  // the response is streaming in and carried a content-length; sits at 100%
  // through the decode phase, cleared when the load settles either way.
  loadProgress?: { loaded: number; total: number };
  sourceNode?: AudioBufferSourceNode;
  proximityGain: GainNode; // 0..1 controlled by GPS distance
  // A play() that arrived before the buffer was ready (typical for late joiners who
  // get a unicast SCHEDULED_ACTION/PLAY in the initial burst without a prior LOAD).
  // Re-invoked from loadAudioForShape() once decode completes.
  pendingPlay?: { audioSource: string; trackTimeSeconds: number; targetServerTime: number; playbackRate: number };
  // Diagnostics: what we last scheduled, so getDebugInfo can compare actual vs
  // intended playback position across tabs.
  lastSchedule?: {
    startedAtCtxTime: number; // audioContext.currentTime when source.start() was called
    startedAtOffset: number; // the second arg to source.start (track position at start)
    targetServerTime: number; // server time the play was scheduled for
    requestedTrackTime: number; // trackTimeSeconds the server requested
    playbackRate: number; // tempo-sync rate; buffer advances at rate × wall-clock
    path: "on-time" | "late"; // which branch playShape took
    // NTP / latency snapshot at the time of scheduling — useful for diagnosing why
    // a tab landed at the wrong wall time. If offsetEstimateMs / outputLatencyMs
    // differ between tabs at schedule time, drift follows.
    offsetEstimateMs: number;
    outputLatencyMs: number;
    isSynced: boolean;
  };
}

const chains = new Map<string, ShapeChain>();

function getOrCreateChain(shapeId: string): ShapeChain {
  const existing = chains.get(shapeId);
  if (existing) return existing;
  const ctx = audioContextManager.getContext();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  // Connect to beatsync's input node (the head of low-pass → master-gain → destination)
  // so map-room audio inherits the room's low-pass + master volume controls just like
  // audio-room playback does.
  gain.connect(audioContextManager.getInputNode());
  const chain: ShapeChain = { proximityGain: gain };
  chains.set(shapeId, chain);
  return chain;
}

/**
 * Fetch + decode an audio source for a shape. Uses beatsync's downloadBufferFromURL
 * helper so map rooms share the same fetch / decode pipeline as the audio room.
 * Sends AUDIO_SOURCE_LOADED to the server when ready so the per-shape load gate
 * can advance.
 */
async function loadAudioForShape(shapeId: string, url: string): Promise<void> {
  const chain = getOrCreateChain(shapeId);
  if (chain.url === url && chain.buffer) {
    notifyLoaded(shapeId, url, chain.buffer.duration);
    return;
  }

  // Same URL already downloading — don't start a second fetch. The cull/resume
  // effect re-fires playShape on every GPS tick while a zone is still loading,
  // and duplicate downloads race each other's onProgress writes (the progress
  // % visibly runs backwards) besides wasting the bandwidth we're waiting on.
  // The in-flight load's completion handles pendingPlay + notifyLoaded.
  if (chain.requestedUrl === url && chain.bufferPromise) return;

  // One delayed retry absorbs transient download failures (flaky network,
  // storage hiccup); a second consecutive failure falls through to the catch
  // below and is surfaced instead of leaving the zone silently "playing".
  // onProgress feeds the load-status UI (bottom bar / zone header) — on slow
  // connections the download IS the wait, so surface how far along it is. A
  // retry's progress restarts from 0, which is honest.
  const attemptDownload = () =>
    downloadBufferFromURL({
      url,
      onProgress: (loaded, total) => {
        chain.loadProgress = { loaded, total };
      },
    }).then((r) => r.audioBuffer);
  const decode = attemptDownload().catch(async (err) => {
    console.warn(`[mapAudio] download/decode failed for shape ${shapeId}, retrying once`, err);
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MS));
    return attemptDownload();
  });

  // Mark this as the latest requested URL, but DON'T touch chain.url yet — that
  // names the track the current buffer actually holds, and until decode finishes
  // the buffer is still the previous track's. Setting chain.url early is what let
  // a scheduled PLAY play the stale buffer while the UI showed the new track (#97).
  chain.requestedUrl = url;
  chain.bufferPromise = decode;
  try {
    const buffer = await decode;
    if (chains.get(shapeId)?.requestedUrl !== url) {
      // A newer load superseded this one before decode finished — drop it.
      return;
    }
    chain.buffer = buffer;
    chain.url = url; // buffer and its URL now agree
    // Mirror the decoded buffer into the global audioSources registry so
    // getAudioDuration (Queue's "--:--" → duration cell) lights up for shape
    // tracks. Audio rooms hit this same path via loadAudioSource() in
    // globalStore; map rooms decode through mapAudio, so we have to write it
    // back ourselves.
    useGlobalStore.setState((state) => ({
      audioSources: state.audioSources.map((as) => (as.source.url === url ? { ...as, status: "loaded", buffer } : as)),
    }));
    notifyLoaded(shapeId, url, buffer.duration);

    // If a play() arrived while we were decoding (late-join resume), re-fire it now
    // that the buffer is ready. Only honor it if the URL still matches the pending
    // play's source — otherwise a newer play has superseded it.
    if (chain.pendingPlay && chain.pendingPlay.audioSource === url) {
      const { audioSource, trackTimeSeconds, targetServerTime, playbackRate } = chain.pendingPlay;
      chain.pendingPlay = undefined;
      playShape(shapeId, audioSource, trackTimeSeconds, targetServerTime, playbackRate);
    }
  } catch (err) {
    console.error(`[mapAudio] decode failed for shape ${shapeId}`, err);
    // Surface the failure — without this the zone shows "playing" while its
    // pendingPlay never fires and stays silent with no explanation. Skip the
    // toast when a newer load superseded this one (its outcome is moot).
    if (chains.get(shapeId)?.requestedUrl === url) {
      // decodeAudioData rejects with a DOMException (EncodingError) — that
      // means the bytes arrived but this browser can't decode the format.
      const reason =
        err instanceof DOMException
          ? "this browser can't decode the file format"
          : err instanceof Error
            ? err.message
            : "download failed";
      toast.error(`Can't play "${trackNameFromUrl(url)}" — ${reason}`);
    }
  } finally {
    if (chain.bufferPromise === decode) {
      chain.bufferPromise = undefined;
      chain.loadProgress = undefined;
    }
  }
}

function notifyLoaded(shapeId: string, url: string, durationSec?: number): void {
  const ws = useGlobalStore.getState().socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // shapeId IS the contextId — every shape owns a playlist context with id =
  // shape.id, so the per-context load gate keys on the same string.
  // durationSec (the decoded buffer's length) lets the server duration-verify
  // beatgrid matches for this track.
  sendWSRequest({
    ws,
    request: {
      type: ClientActionEnum.enum.AUDIO_SOURCE_LOADED,
      source: { url, ...(durationSec !== undefined && durationSec > 0 && { durationSec }) },
      contextId: shapeId,
    },
  });
}

/** Stop + disconnect a source immediately, tolerating already-stopped nodes. */
function stopSource(source: AudioBufferSourceNode | undefined): void {
  if (!source) return;
  source.onended = null;
  try {
    source.stop();
  } catch {
    /* already stopped */
  }
  source.disconnect();
}

/**
 * Schedule playback of a shape at the given server-time. Uses globalStore's
 * computeScheduleTiming so the math (NTP offset + nudge + output-latency
 * compensation + clamping) is identical to audio-room scheduling.
 *
 * playbackRate ≠ 1 = zone beat-matching (SYNC_ZONES): the buffer position
 * advances at rate × wall-clock, so every conversion between elapsed wall time
 * and buffer offset below must scale by the rate.
 */
function playShape(
  shapeId: string,
  audioSource: string,
  trackTimeSeconds: number,
  targetServerTime: number,
  playbackRate: number = 1
): void {
  const chain = getOrCreateChain(shapeId);

  // Buffer not ready (typical for late-join unicast resumes where there's no load
  // gate). Stash the play parameters; loadAudioForShape will replay once decode
  // completes.
  if (!chain.buffer || chain.url !== audioSource) {
    // Switching to a different track: stop the current source NOW. Otherwise it
    // keeps looping (source.loop) audibly while the new track decodes, so the UI
    // shows the new track but you still hear the previous one (#97). A brief
    // silence during decode is expected (and closed by the server timeline).
    if (chain.url !== audioSource && chain.sourceNode) {
      try {
        chain.sourceNode.stop();
      } catch {
        /* already stopped */
      }
      chain.sourceNode.disconnect();
      chain.sourceNode = undefined;
    }
    chain.pendingPlay = { audioSource, trackTimeSeconds, targetServerTime, playbackRate };
    void loadAudioForShape(shapeId, audioSource);
    return;
  }

  // NTP not synced yet (typical for a freshly-opened tab). Scheduling now would use
  // a stale offsetEstimate and land at the wrong wall time. Poll for sync, then re-fire.
  if (!useGlobalStore.getState().isSynced) {
    chain.pendingPlay = { audioSource, trackTimeSeconds, targetServerTime, playbackRate };
    waitForNtpSyncThenReplay(shapeId);
    return;
  }

  // AudioContext is suspended until the user makes a gesture. While suspended,
  // ctx.currentTime DOES NOT ADVANCE (Web Audio spec). If we call source.start(t)
  // now, the source won't actually play until t units of ctx-time have elapsed *after*
  // resume — which means audible playback is delayed by however long the context
  // remained suspended. That's the late-join-drift bug: new tab opens, server sends
  // the resume PLAY, NTP syncs, decode finishes, schedule is computed correctly, then
  // we wait for the user to click → context resumes → playback is N seconds late.
  //
  // Defer scheduling until the context is running. The autoplay-unlock effect in
  // MapRoom calls resume() on the first user gesture; once it fires, the statechange
  // listener below re-invokes playShape with the original args.
  if (audioContextManager.getContext().state !== "running") {
    chain.pendingPlay = { audioSource, trackTimeSeconds, targetServerTime, playbackRate };
    waitForAudioContextRunningThenReplay(shapeId);
    return;
  }

  chain.pendingPlay = undefined;

  // Previous source (reschedules: track change, seek, SYNC_ZONES). Don't stop it
  // yet — it keeps playing until the new schedule's start moment so reschedules
  // are gapless; we stop it at exactly startAt below.
  const oldSource = chain.sourceNode;
  chain.sourceNode = undefined;

  const ctx = audioContextManager.getContext();
  const source = audioContextManager.createBufferSource();
  source.buffer = chain.buffer;
  // Zone loop semantics (#99): "loop" loops the whole PLAYLIST, not one song.
  //  - A single-track looping zone loops the buffer seamlessly (gapless) — no
  //    advance needed, so keep source.loop = true.
  //  - A multi-track zone (or a non-looping zone) plays each track once and
  //    advances via the onended handler below (wrapping to the top iff loop).
  const playlistNow = useGlobalStore.getState().playlists.get(shapeId);
  const trackCount = playlistNow?.tracks.length ?? 1;
  const zoneLoops = playlistNow?.loop ?? false;
  source.loop = trackCount <= 1 && zoneLoops;
  source.playbackRate.value = playbackRate; // beat-sync tempo (SYNC_ZONES); 1 = normal
  source.connect(chain.proximityGain);

  // Beatsync's exact scheduling logic, adapted for per-shape playback. Two cases:
  //
  //  1. ON TIME: rawWaitMs >= MIN_SCHEDULE_LEAD_MS. We have real audio-thread lead
  //     time, so source.start lands sample-accurately. waitSeconds already accounts
  //     for output latency, so audible playback hits targetServerTime exactly.
  //
  //  2. LATE: rawWaitMs < MIN_SCHEDULE_LEAD_MS. Calling source.start with ~0 lead
  //     is racy (different tabs land a few ms apart → drift). Instead, give the
  //     audio thread LATE_RETRY_DELAY_MS of lead time and advance the buffer
  //     offset by the same amount + however long we've already missed. Mirrors
  //     schedulePlay's retry-with-delay path in global.tsx:786.
  const { waitSeconds, rawWaitMs, outputLatencyMs } = computeScheduleTiming(targetServerTime);
  const duration = chain.buffer.duration;
  const state = useGlobalStore.getState();

  let startAt: number;
  let offsetRaw: number;
  let path: "on-time" | "late";

  if (rawWaitMs >= MIN_SCHEDULE_LEAD_MS) {
    startAt = ctx.currentTime + waitSeconds;
    offsetRaw = trackTimeSeconds;
    path = "on-time";
  } else {
    // Late path. epochNow here matches the one calculateWaitTimeMilliseconds used
    // inside computeScheduleTiming a moment ago, so the elapsed math is consistent.
    //
    // Sample becomes audible at wall time (now + LATE_RETRY_DELAY + outputLatency).
    // Mapped to server time, that's (target + elapsed + LATE_RETRY_DELAY + outputLatency).
    // For the audible position to match the server's intended timeline, the buffer
    // offset must be advanced by the same delta — INCLUDING outputLatency. The
    // on-time path's compensation hides this; the late path has to add it explicitly.
    // The wall-clock delta converts to buffer seconds through playbackRate: a
    // tempo-synced zone's buffer advances at rate × wall-clock.
    const effectiveOffsetMs = state.offsetEstimate + state.nudgeOffsetMs;
    const elapsedSinceTargetMs = epochNow() + effectiveOffsetMs - targetServerTime;
    startAt = ctx.currentTime + LATE_RETRY_DELAY_MS / 1000;
    offsetRaw =
      trackTimeSeconds + (playbackRate * (elapsedSinceTargetMs + LATE_RETRY_DELAY_MS + outputLatencyMs)) / 1000;
    path = "late";
  }

  // Wrap into the looped buffer's range.
  const offset = duration > 0 ? ((offsetRaw % duration) + duration) % duration : 0;

  try {
    source.start(startAt, offset);
  } catch (err) {
    console.error(`[mapAudio] failed to start shape ${shapeId}`, err);
    stopSource(oldSource); // new source failed — don't leave the old one orphaned
    return;
  }
  // Hand over at the exact moment the new source begins (sample-accurate,
  // audio-thread timed) so reschedules/syncs are gapless.
  if (oldSource) {
    oldSource.onended = () => oldSource.disconnect();
    try {
      oldSource.stop(startAt);
    } catch {
      stopSource(oldSource); // already stopped
    }
  }
  chain.sourceNode = source;
  // Non-seamless sources advance the playlist when they finish (#99). Seamless
  // single-track loops (source.loop === true) never end, so no handler.
  if (!source.loop) {
    source.onended = () => advanceZonePlaylist(shapeId, source);
  }
  chain.lastSchedule = {
    startedAtCtxTime: startAt,
    startedAtOffset: offset,
    targetServerTime,
    requestedTrackTime: trackTimeSeconds,
    playbackRate,
    path,
    offsetEstimateMs: state.offsetEstimate,
    outputLatencyMs,
    isSynced: state.isSynced,
  };
}

/**
 * A zone track finished playing — advance to the next track in the zone's
 * playlist (#99). Wraps to the top only if the zone's loop flag is set; a
 * non-looping zone stops at the end of its playlist.
 *
 * Every in-range client runs this at ~the same instant (they all started the
 * track at the same server time), so they all broadcast the next PLAY. The
 * server collapses the duplicate requests (last-write-wins in the play batch),
 * exactly like the audio room's onended → skipToNextTrack → broadcastPlay path.
 * Clients that are range-culled tore their source down (no onended), so a zone
 * only advances while at least one listener is near it.
 */
function advanceZonePlaylist(shapeId: string, endedSource: AudioBufferSourceNode): void {
  const chain = chains.get(shapeId);
  // Only a natural end leaves this as the live source. A manual stop, pause, or
  // track switch reassigns chain.sourceNode first, so bail in those cases.
  if (!chain || chain.sourceNode !== endedSource) return;

  const state = useGlobalStore.getState();
  const playlist = state.playlists.get(shapeId);
  if (!playlist || playlist.tracks.length === 0) return;

  const idx = playlist.tracks.findIndex((t) => t.url === chain.url);
  let nextIdx = idx + 1;
  if (nextIdx >= playlist.tracks.length) {
    if (!playlist.loop) return; // end of a non-looping playlist → stop
    nextIdx = 0;
  }
  const nextUrl = playlist.tracks[nextIdx]?.url;
  if (!nextUrl) return;

  const ws = state.socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendWSRequest({
    ws,
    request: {
      type: ClientActionEnum.enum.PLAY,
      contextId: shapeId,
      audioSource: nextUrl,
      trackTimeSeconds: 0,
    },
  });
}

function pauseShape(shapeId: string): void {
  const chain = chains.get(shapeId);
  if (!chain) return;
  // Clear any pending play that's waiting on decode / NTP / autoplay-unlock.
  // Without this, pressing pause during the URL-change decode interval would
  // let the queued play fire once decode finishes — audio plays despite the
  // user having paused. Also clear the NTP / context-state waiters so they
  // don't trigger after pause.
  chain.pendingPlay = undefined;
  const ntpWaiter = ntpWaiters.get(shapeId);
  if (ntpWaiter) {
    clearInterval(ntpWaiter);
    ntpWaiters.delete(shapeId);
  }
  const ctxWaiter = ctxWaiters.get(shapeId);
  if (ctxWaiter) {
    audioContextManager.getContext().removeEventListener("statechange", ctxWaiter);
    ctxWaiters.delete(shapeId);
  }
  if (!chain.sourceNode) return;
  stopSource(chain.sourceNode);
  chain.sourceNode = undefined;
}

/**
 * Set the proximity gain for a shape (0..1). Uses linearRampToValueAtTime with a
 * short ramp to avoid zipper noise on rapid GPS updates.
 */
function setProximityGain(shapeId: string, gain: number): void {
  const chain = getOrCreateChain(shapeId);
  const ctx = audioContextManager.getContext();
  const clamped = Math.max(0, Math.min(1, gain));
  const param = chain.proximityGain.gain;
  param.cancelScheduledValues(ctx.currentTime);
  param.setValueAtTime(param.value, ctx.currentTime);
  param.linearRampToValueAtTime(clamped, ctx.currentTime + MAP_CONSTANTS.PROXIMITY_GAIN_RAMP_SECONDS);
}

function unloadShape(shapeId: string): void {
  const chain = chains.get(shapeId);
  if (!chain) return;
  pauseShape(shapeId);
  chain.proximityGain.disconnect();
  chains.delete(shapeId);
  useMapStore.getState().setShapeAudioChain(shapeId, undefined);
}

/** Replay a shape's pending play once it's stored. Used by both the NTP and the
 *  AudioContext-state gates so they share one re-entry point. */
function replayPendingPlay(shapeId: string): void {
  const chain = chains.get(shapeId);
  if (!chain?.pendingPlay) return;
  // Carry playbackRate through the replay — dropping it here reset beat-synced
  // zones (rate ≠ 1) to normal speed when a play resumed via the NTP or
  // autoplay-unlock gates.
  const { audioSource, trackTimeSeconds, targetServerTime, playbackRate } = chain.pendingPlay;
  chain.pendingPlay = undefined;
  playShape(shapeId, audioSource, trackTimeSeconds, targetServerTime, playbackRate);
}

/**
 * Poll the global store every 100ms until NTP is synced, then re-fire the pending
 * play for the given shape. Each shape can have at most one pending wait at a time.
 */
const ntpWaiters = new Map<string, ReturnType<typeof setInterval>>();
function waitForNtpSyncThenReplay(shapeId: string): void {
  if (ntpWaiters.has(shapeId)) return;
  const id = setInterval(() => {
    if (!useGlobalStore.getState().isSynced) return;
    clearInterval(id);
    ntpWaiters.delete(shapeId);
    replayPendingPlay(shapeId);
  }, 100);
  ntpWaiters.set(shapeId, id);
}

/**
 * Listen for the AudioContext to transition to "running" (which happens after the
 * first user gesture unlocks autoplay), then re-fire the pending play. We attach a
 * statechange listener per shape — once it fires for any shape, all pending shapes
 * become eligible, but we keep them per-shape so the cleanup is straightforward.
 */
const ctxWaiters = new Map<string, () => void>();
function waitForAudioContextRunningThenReplay(shapeId: string): void {
  if (ctxWaiters.has(shapeId)) return;
  const ctx = audioContextManager.getContext();
  const handler = () => {
    if (ctx.state !== "running") return;
    ctx.removeEventListener("statechange", handler);
    ctxWaiters.delete(shapeId);
    replayPendingPlay(shapeId);
  };
  ctx.addEventListener("statechange", handler);
  ctxWaiters.set(shapeId, handler);
}

function reset(): void {
  for (const id of ntpWaiters.values()) clearInterval(id);
  ntpWaiters.clear();
  const ctx = audioContextManager.getContext();
  for (const handler of ctxWaiters.values()) ctx.removeEventListener("statechange", handler);
  ctxWaiters.clear();
  for (const shapeId of Array.from(chains.keys())) unloadShape(shapeId);
}

export interface ShapePlaybackDebug {
  shapeId: string;
  isPlaying: boolean;
  bufferDuration?: number;
  /** Where in the buffer we're playing RIGHT NOW (mod duration), based on ctx clock. */
  currentPosition?: number;
  /** Same as currentPosition but where the SERVER would say we should be — for comparison. */
  intendedPosition?: number;
  /** Difference: positive = we're ahead of server, negative = behind. In seconds. */
  driftSeconds?: number;
  /** Tempo-sync rate of the current schedule (1 = normal). */
  playbackRate?: number;
  /** Fraction of the current beat elapsed [0,1), from the track's beatgrid if known.
   *  Two beat-matched zones should show matching values (mod 1). */
  beatPhase?: number;
  lastSchedule?: ShapeChain["lastSchedule"];
}

/**
 * Snapshot of each shape's current playback state for the debug UI. Compare across
 * tabs to spot drift: currentPosition values should match within a few ms.
 */
function getDebugInfo(): ShapePlaybackDebug[] {
  const ctx = audioContextManager.getContext();
  const state = useGlobalStore.getState();
  const effectiveOffsetMs = state.offsetEstimate + state.nudgeOffsetMs;
  const serverNowMs = Date.now() + effectiveOffsetMs;

  const out: ShapePlaybackDebug[] = [];
  for (const [shapeId, chain] of chains.entries()) {
    const info: ShapePlaybackDebug = {
      shapeId,
      isPlaying: !!chain.sourceNode,
      bufferDuration: chain.buffer?.duration,
      lastSchedule: chain.lastSchedule,
    };
    if (chain.sourceNode && chain.lastSchedule && chain.buffer) {
      // Buffer position advances at playbackRate × wall-clock (tempo-synced zones).
      const rate = chain.lastSchedule.playbackRate;
      info.playbackRate = rate;
      const elapsedSinceStart = ctx.currentTime - chain.lastSchedule.startedAtCtxTime;
      const rawPos = chain.lastSchedule.startedAtOffset + rate * Math.max(0, elapsedSinceStart);
      info.currentPosition = ((rawPos % chain.buffer.duration) + chain.buffer.duration) % chain.buffer.duration;

      // What the server would say the position should be at the current moment.
      const elapsedSinceTargetMs = serverNowMs - chain.lastSchedule.targetServerTime;
      const intendedRaw = chain.lastSchedule.requestedTrackTime + (rate * Math.max(0, elapsedSinceTargetMs)) / 1000;
      info.intendedPosition = ((intendedRaw % chain.buffer.duration) + chain.buffer.duration) % chain.buffer.duration;

      // Drift = current - intended. Wrap into [-duration/2, duration/2] for sane sign.
      const d = info.currentPosition - info.intendedPosition;
      const half = chain.buffer.duration / 2;
      info.driftSeconds = d > half ? d - chain.buffer.duration : d < -half ? d + chain.buffer.duration : d;

      // Beat phase from the track's beatgrid (when imported): fraction of the
      // current beat elapsed. Beat-matched zones should agree on this number.
      const track = state.playlists.get(shapeId)?.tracks.find((t) => t.url === chain.url);
      if (track?.beatgrid && info.currentPosition !== undefined) {
        const beatsIn = ((info.currentPosition - track.beatgrid.firstDownbeatSec) * track.beatgrid.bpm) / 60;
        info.beatPhase = ((beatsIn % 1) + 1) % 1;
      }
    }
    out.push(info);
  }
  return out;
}

/** Snapshot of every shape id with an active audio chain. Used by the React
 *  layer to detect shapes that disappeared from the server and tear them down. */
function knownShapeIds(): string[] {
  return Array.from(chains.keys());
}

/** True if we're locally playing this shape (source node is alive). The
 *  server may say a shape is "playing" while we're locally paused (because
 *  we're far away and the listener is range-culling). */
function isShapePlaying(shapeId: string): boolean {
  return !!chains.get(shapeId)?.sourceNode;
}

/** What THIS device is doing with a zone's audio right now — the server's
 *  playbackState says what SHOULD be playing; this says what IS:
 *   - "playing": a source node is live (sound is/will be produced here)
 *   - "loading": download/decode in flight, or a play stashed waiting on it —
 *     sound is coming, not yet (the slow-connection silent gap)
 *   - "idle": nothing local (paused, range-culled, or load failed) */
export type ShapeLocalState = "playing" | "loading" | "idle";
export interface ZoneLoadInfo {
  state: ShapeLocalState;
  /** Download progress in bytes; present only while "loading" with a known
   *  content-length. Reads 100% during the decode phase. */
  loadedBytes?: number;
  totalBytes?: number;
  /** URL of the track this zone has DECODED and ready. Consumers compare it to
   *  the zone's current track to tell "loaded, plays instantly" (map: green)
   *  from "would need a download first" (map: gray). Absent while nothing is
   *  buffered — a zone with no chain at all is simply missing from the Map. */
  bufferedUrl?: string;
}

/** Per-shape local snapshot for the load-status UI (polled — mapAudio is
 *  imperative, so there's nothing to subscribe to). */
function getLocalStates(): Map<string, ZoneLoadInfo> {
  const out = new Map<string, ZoneLoadInfo>();
  for (const [shapeId, chain] of chains.entries()) {
    const state: ShapeLocalState = chain.sourceNode
      ? "playing"
      : chain.bufferPromise || chain.pendingPlay
        ? "loading"
        : "idle";
    const info: ZoneLoadInfo = { state };
    if (state === "loading" && chain.loadProgress?.total) {
      info.loadedBytes = chain.loadProgress.loaded;
      info.totalBytes = chain.loadProgress.total;
    }
    if (chain.buffer && chain.url) {
      info.bufferedUrl = chain.url;
    }
    out.set(shapeId, info);
  }
  return out;
}

/**
 * Download + decode every zone's current track NOW, ignoring range gating, so
 * walking into any zone later starts instantly instead of stalling on a
 * download (the slow-connection late-join gap). Device-local only — the only
 * server traffic is the standard AUDIO_SOURCE_LOADED notifications.
 *
 * Deliberate RAM-for-latency trade: decoded PCM is ~20 MB per track-minute and
 * map chains keep buffers until the shape is deleted (range-culling only tears
 * down source nodes) — which is exactly what makes preloading stick. Hence an
 * explicit user action, not a default.
 */
function preloadAllZones(): { started: number; alreadyLoaded: number; total: number } {
  const { playlists } = useGlobalStore.getState();
  let started = 0;
  let alreadyLoaded = 0;
  let total = 0;
  for (const p of playlists.values()) {
    if (p.id === MAIN_CONTEXT_ID) continue; // Room Pool is a library, not a zone
    // The track we'd hear on entry: the scheduled one, else the queue head.
    const url = p.playbackState.audioSource || p.tracks[0]?.url;
    if (!url) continue;
    total++;
    const chain = chains.get(p.id);
    const decoded = chain?.url === url && !!chain.buffer;
    // In-flight requires a live bufferPromise — a failed load leaves
    // requestedUrl set with no promise, and preload should retry those.
    const inFlight = chain?.requestedUrl === url && !!chain.bufferPromise;
    if (decoded || inFlight) {
      alreadyLoaded++;
      continue;
    }
    started++;
    void loadAudioForShape(p.id, url);
  }
  return { started, alreadyLoaded, total };
}

export const mapAudio = {
  loadAudioForShape,
  playShape,
  pauseShape,
  isShapePlaying,
  getLocalStates,
  preloadAllZones,
  setProximityGain,
  unloadShape,
  knownShapeIds,
  reset,
  getDebugInfo,
};
