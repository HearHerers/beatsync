"use client";

// Toggleable diagnostic overlay. Enable by adding ?debug=1 to the URL.
// Renders nothing when disabled, so zero cost in normal use.
//
// Surfaces what the per-probe console logs used to (silenced in #41), but in
// a UI element instead of flooding the browser console. Read-only — pure
// observability, no controls.
//
// First pass: NTP probe stats + recent probe history. Tracking issue #46
// covers further additions (per-shape playback drift for map rooms, drag,
// historical graphs).

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getProbeHistory, getProbeStats, type ProbeResult } from "@/utils/ntp";

const POLL_MS = 200;
const RECENT_PROBES_VISIBLE = 12;

function DebugOverlayInner() {
  const searchParams = useSearchParams();
  const debugEnabled = searchParams?.get("debug") === "1";

  const [stats, setStats] = useState(() => getProbeStats());
  const [history, setHistory] = useState<ProbeResult[]>(() => getProbeHistory());

  useEffect(() => {
    if (!debugEnabled) return;
    const tick = () => {
      setStats(getProbeStats());
      setHistory(getProbeHistory());
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [debugEnabled]);

  if (!debugEnabled) return null;

  const pureRate = stats.totalPairs > 0 ? ((stats.pureCount / stats.totalPairs) * 100).toFixed(0) : "—";

  return (
    <div className="pointer-events-auto fixed right-2 top-2 z-[1000] w-72 select-text rounded border border-neutral-700 bg-neutral-950/90 p-2 font-mono text-[10px] leading-tight text-neutral-200 shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center justify-between border-b border-neutral-700 pb-1">
        <span className="font-semibold tracking-wide">debug · ntp</span>
        <span className="text-neutral-500">?debug=1</span>
      </div>

      <div className="mb-1">
        <div>
          probes pure <span className="text-green-400">{stats.pureCount}</span>
          <span className="text-neutral-500">/</span>
          {stats.totalPairs} <span className="text-neutral-500">({pureRate}%)</span>
        </div>
        <div className="text-neutral-400">
          sent {stats.totalSent} · impure {stats.impureCount}
        </div>
      </div>

      <div className="border-t border-neutral-700 pt-1">
        <div className="mb-0.5 text-neutral-500">recent</div>
        {history.length === 0 ? (
          <div className="text-neutral-600">no probes yet</div>
        ) : (
          <div className="max-h-48 overflow-y-auto">
            {history.slice(0, RECENT_PROBES_VISIBLE).map((p) => (
              <ProbeRow key={p.probeGroupId} probe={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProbeRow({ probe }: { probe: ProbeResult }) {
  const tag = probe.isPure ? <span className="text-green-400">✓</span> : <span className="text-amber-400">✗</span>;
  return (
    <div className="whitespace-nowrap">
      <span className="text-neutral-500">#{probe.probeGroupId}</span> {tag}{" "}
      <span className="text-neutral-400">drift</span> <span className="text-cyan-300">{probe.gapDrift.toFixed(1)}</span>
      <span className="text-neutral-500">ms</span>
      {probe.bestRTT !== undefined && (
        <>
          {" · "}
          <span className="text-neutral-400">rtt</span>{" "}
          <span className="text-cyan-300">{probe.bestRTT.toFixed(1)}</span>
          <span className="text-neutral-500">ms</span>
          {" · "}
          <span className="text-neutral-400">off</span>{" "}
          <span className="text-cyan-300">
            {probe.bestOffset !== undefined && probe.bestOffset >= 0 ? "+" : ""}
            {probe.bestOffset?.toFixed(1) ?? "—"}
          </span>
          <span className="text-neutral-500">ms</span>
        </>
      )}
    </div>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary at the page-tree level on
 * Next.js 14+; wrap the inner component so this overlay can be mounted
 * anywhere without bringing its own SSR baggage to the host.
 */
export function DebugOverlay() {
  return (
    <Suspense fallback={null}>
      <DebugOverlayInner />
    </Suspense>
  );
}
