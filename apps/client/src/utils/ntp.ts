import { ClientActionEnum, epochNow, NTP_CONSTANTS } from "@beatsync/shared";
import { sendWSRequest } from "./ws";

// ── Types ──────────────────────────────────────────────────────────

export interface NTPMeasurement {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
  roundTripDelay: number;
  clockOffset: number;
}

// ── Probe pair sending ─────────────────────────────────────────────

let probeGroupCounter = 0;
let pendingFirstProbe: NTPMeasurement | null = null;
let pendingFirstProbeGroupId: number | null = null;
let pureCount = 0;
let impureCount = 0;

/** A completed probe-pair result, captured for the debug UI. */
export interface ProbeResult {
  probeGroupId: number;
  isPure: boolean;
  clientGap: number;
  serverGap: number;
  gapDrift: number;
  /** Only set when isPure (impure pairs are discarded by the offset estimator). */
  bestRTT?: number;
  bestOffset?: number;
  /** Wall-clock ms at the moment the pair was validated. */
  timestamp: number;
}

const PROBE_HISTORY_CAPACITY = 50;
const probeHistory: ProbeResult[] = [];

const recordProbeResult = (result: ProbeResult) => {
  probeHistory.unshift(result);
  if (probeHistory.length > PROBE_HISTORY_CAPACITY) {
    probeHistory.length = PROBE_HISTORY_CAPACITY;
  }
};

/** Reset probe state (call on connection reset) */
export const resetProbeState = () => {
  probeGroupCounter = 0;
  pendingFirstProbe = null;
  pendingFirstProbeGroupId = null;
  pureCount = 0;
  impureCount = 0;
  probeHistory.length = 0;
};

/** Get probe pair stats for debugging */
export const getProbeStats = () => ({
  totalPairs: pureCount + impureCount,
  pureCount,
  impureCount,
  totalSent: probeGroupCounter,
});

/** Snapshot of recent probe results (newest first), up to PROBE_HISTORY_CAPACITY entries. */
export const getProbeHistory = (): ProbeResult[] => probeHistory.slice();

/**
 * Send a coded probe pair (Huygens). Two NTP requests sent with a known
 * inter-departure gap. The client later validates that the server-side
 * inter-arrival gap matches, filtering out measurements corrupted by
 * queuing, TCP HOL blocking, or GC pauses.
 */
export const sendProbePair = (data: {
  ws: WebSocket;
  currentRTT: number | undefined;
  compensationMs: number | undefined;
  nudgeMs: number | undefined;
}) => {
  const { ws, currentRTT, compensationMs, nudgeMs } = data;
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("Cannot send NTP request: WebSocket is not open");
  }

  const probeGroupId = probeGroupCounter++;

  // First probe — sent immediately
  sendWSRequest({
    ws,
    request: {
      type: ClientActionEnum.enum.NTP_REQUEST,
      t0: epochNow(),
      clientRTT: currentRTT,
      clientCompensationMs: compensationMs,
      clientNudgeMs: nudgeMs,
      probeGroupId,
      probeGroupIndex: 0,
    },
  });

  // Second probe — sent after PROBE_GAP_MS
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    sendWSRequest({
      ws,
      request: {
        type: ClientActionEnum.enum.NTP_REQUEST,
        t0: epochNow(),
        clientRTT: currentRTT,
        clientCompensationMs: compensationMs,
        clientNudgeMs: nudgeMs,
        probeGroupId,
        probeGroupIndex: 1,
      },
    });
  }, NTP_CONSTANTS.PROBE_GAP_MS);
};

// ── Probe pair collection ──────────────────────────────────────────

/**
 * Feed an individual probe response into the pair validator.
 *
 * Buffers the first probe (index 0). When the second probe (index 1)
 * arrives, validates gap purity and returns the best measurement
 * (lowest RTT) from the pair. Returns null if still waiting for the
 * second probe, the pair was impure, or the group ID didn't match.
 */
export const validateProbePair = (data: {
  measurement: NTPMeasurement;
  probeGroupId: number;
  probeGroupIndex: number;
}): NTPMeasurement | null => {
  const { measurement, probeGroupId, probeGroupIndex } = data;

  if (probeGroupIndex === 0) {
    pendingFirstProbe = measurement;
    pendingFirstProbeGroupId = probeGroupId;
    return null;
  }

  // probeGroupIndex === 1: try to complete the pair
  const first = pendingFirstProbe;
  const firstGroupId = pendingFirstProbeGroupId;

  if (!first || firstGroupId !== probeGroupId) {
    return null;
  }

  // Clear pending state
  pendingFirstProbe = null;
  pendingFirstProbeGroupId = null;

  // Validate gap purity: compare server inter-arrival gap against client inter-departure gap
  const clientGap = measurement.t0 - first.t0;
  const serverGap = measurement.t1 - first.t1;
  const gapDrift = Math.abs(serverGap - clientGap);
  const isPure = gapDrift <= NTP_CONSTANTS.PROBE_GAP_TOLERANCE_MS;

  if (isPure) {
    pureCount++;
  } else {
    impureCount++;
  }

  if (!isPure) {
    recordProbeResult({
      probeGroupId,
      isPure: false,
      clientGap,
      serverGap,
      gapDrift,
      timestamp: Date.now(),
    });
    return null;
  }

  const best = first.roundTripDelay <= measurement.roundTripDelay ? first : measurement;
  recordProbeResult({
    probeGroupId,
    isPure: true,
    clientGap,
    serverGap,
    gapDrift,
    bestRTT: best.roundTripDelay,
    bestOffset: best.clockOffset,
    timestamp: Date.now(),
  });
  return best;
};

// ── Offset estimation ──────────────────────────────────────────────

/**
 * Estimate clock offset using min-RTT selection.
 *
 * Queuing delays can only ADD to RTT, never subtract. So the lowest-RTT
 * measurement is closest to the true propagation delay, and its offset
 * has the least asymmetric queuing contamination (RFC 5905 §10).
 */
export const calculateOffsetEstimate = (measurements: NTPMeasurement[]) => {
  let minRTT = Infinity;
  let bestOffset = 0;
  for (const m of measurements) {
    if (m.roundTripDelay < minRTT) {
      minRTT = m.roundTripDelay;
      bestOffset = m.clockOffset;
    }
  }

  const totalRoundTrip = measurements.reduce((sum, m) => sum + m.roundTripDelay, 0);
  const averageRoundTrip = measurements.length > 0 ? totalRoundTrip / measurements.length : 0;

  return { averageOffset: bestOffset, averageRoundTrip };
};

export const calculateWaitTimeMilliseconds = (targetServerTime: number, clockOffset: number): number => {
  const estimatedCurrentServerTime = epochNow() + clockOffset;
  return Math.max(0, targetServerTime - estimatedCurrentServerTime);
};
