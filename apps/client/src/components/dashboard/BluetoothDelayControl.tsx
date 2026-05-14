"use client";
// Bluetooth / output-latency compensation control. Wraps the existing
// `nudge({ amountMs })` action with a friendly dropdown of common BT codec
// latencies + a free-form slider for custom values.
//
// Sign convention: BT earbuds add latency *after* the local audio stack, which
// the browser's AudioContext.outputLatency can't see. Compensating means
// scheduling playback EARLIER by that many ms — internally `nudgeOffsetMs` is
// negative, but we surface it as a positive "delay compensation" number which
// matches how users think about their headphones ("my AirPods add ~180ms").

import { cn } from "@/lib/utils";
import { useGlobalStore } from "@/store/global";
import { Headphones } from "lucide-react";
import { useEffect, useState } from "react";
import { Slider } from "../ui/slider";

interface Preset {
  label: string;
  /** Delay added by this device, in ms. We schedule playback earlier by this much. */
  delayMs: number;
  hint?: string;
}

// Common codec latencies — rough averages from public measurements.
const PRESETS: Preset[] = [
  { label: "Wired / speakers", delayMs: 0, hint: "no compensation" },
  { label: "LE Audio (LC3)", delayMs: 25 },
  { label: "aptX LL", delayMs: 40 },
  { label: "aptX", delayMs: 100 },
  { label: "AirPods / AAC", delayMs: 180 },
];

const MAX_DELAY_MS = 500;

export const BluetoothDelayControl = () => {
  const nudgeOffsetMs = useGlobalStore((s) => s.nudgeOffsetMs);
  const nudge = useGlobalStore((s) => s.nudge);
  // Surface negative nudge as positive "delay being compensated for".
  const currentDelayMs = -nudgeOffsetMs;
  const [draft, setDraft] = useState<number>(currentDelayMs);
  // Sync draft to external changes (other UI also writes nudgeOffsetMs).
  useEffect(() => {
    setDraft(currentDelayMs);
  }, [currentDelayMs]);

  const selectedPreset = PRESETS.find((p) => p.delayMs === currentDelayMs);
  const isCustom = !selectedPreset;

  const applyDelayMs = (delayMs: number) => {
    // The internal action takes a *relative* nudge. Compute the diff between
    // the target absolute value (which is the negation of delayMs) and current.
    const targetNudge = -delayMs;
    const diff = targetNudge - nudgeOffsetMs;
    if (diff === 0) return;
    nudge({ amountMs: diff });
  };

  return (
    <div className="px-3.5 py-2 space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-medium text-neutral-400">
        <Headphones className="h-3 w-3" />
        <span>Audio output</span>
        <span className="ml-auto font-mono text-neutral-300">
          {currentDelayMs >= 0 ? "+" : ""}
          {currentDelayMs}ms
        </span>
      </div>

      {/* Preset list — clicking jumps the nudge to that absolute value. */}
      <div className="grid grid-cols-2 gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyDelayMs(p.delayMs)}
            className={cn(
              "text-[10px] px-2 py-1 rounded border transition-colors text-left",
              currentDelayMs === p.delayMs
                ? "border-primary-600 bg-primary-600/10 text-primary-300"
                : "border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:bg-neutral-800/80 hover:text-neutral-200"
            )}
            title={p.hint}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Free slider for arbitrary values. Click in here = "Custom". */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] text-neutral-500">
          <span>Custom</span>
          {isCustom && <span className="font-mono text-neutral-300">{currentDelayMs}ms</span>}
        </div>
        <Slider
          value={[draft]}
          min={0}
          max={MAX_DELAY_MS}
          step={5}
          onValueChange={(v) => setDraft(v[0])}
          onValueCommit={(v) => applyDelayMs(v[0])}
        />
        <div className="text-[9px] text-neutral-600">
          Raise this if audio sounds late to you — your earbuds&apos; codec delay.
        </div>
      </div>
    </div>
  );
};
