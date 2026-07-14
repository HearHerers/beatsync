"use client";
// Audio settings panel — gathers the per-device tuning controls that used to
// live in the Users panel (Left): sync info bar, audio-output delay
// compensation, global volume, and manual timing nudge. Rendered as its own
// mobile tab in MapRoom and Dashboard so the Users panel stays reserved for
// the connected-users list and playback permissions.

import { audioContextManager } from "@/lib/audioContextManager";
import { cn } from "@/lib/utils";
import { MAX_NTP_MEASUREMENTS, useGlobalStore } from "@/store/global";
import { Separator } from "../ui/separator";
import { BluetoothDelayControl } from "./BluetoothDelayControl";
import { GlobalVolumeControl } from "./GlobalVolumeControl";
import { MobileNudgeControl } from "./MobileNudgeControl";

interface SettingsPanelProps {
  className?: string;
}

export const SettingsPanel = ({ className }: SettingsPanelProps) => {
  const clockOffset = useGlobalStore((state) => state.offsetEstimate);
  const roundTripEstimate = useGlobalStore((state) => state.roundTripEstimate);
  const syncMeasurementCount = useGlobalStore((state) => state.syncMeasurements.length);

  return (
    <div
      className={cn(
        "w-full flex flex-col text-sm space-y-1 overflow-y-auto bg-neutral-900/50 backdrop-blur-md scrollbar-thin scrollbar-thumb-rounded-md scrollbar-thumb-muted-foreground/10 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/20",
        className
      )}
    >
      {/* Sync info bar */}
      <div className="flex items-center gap-3 px-3.5 py-2 text-[10px] font-mono text-neutral-500">
        <span>Offset: {clockOffset.toFixed(1)}ms</span>
        <span>RTT: {roundTripEstimate.toFixed(1)}ms</span>
        <span>OL: {((audioContextManager.getContext().outputLatency ?? 0) * 1000).toFixed(0)}ms</span>
        <span>
          NTP: {syncMeasurementCount}/{MAX_NTP_MEASUREMENTS}
        </span>
      </div>

      <Separator className="bg-neutral-800/50" />

      <BluetoothDelayControl />

      <Separator className="bg-neutral-800/50" />

      <GlobalVolumeControl isMobile />

      <Separator className="bg-neutral-800/50" />

      <MobileNudgeControl />

      {/* Tips Section */}
      <div className="mt-auto pb-4 pt-2 text-neutral-400">
        <div className="flex flex-col gap-2 p-4 border-t border-neutral-800/50">
          <h5 className="text-xs font-medium text-neutral-300">Tips</h5>
          <ul className="list-disc list-outside pl-4 space-y-1.5">
            <li className="text-xs leading-relaxed">
              Sync is optimal when audio outputs directly from the speaker. For Bluetooth output, you may need to adjust
              the delay settings here.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};
