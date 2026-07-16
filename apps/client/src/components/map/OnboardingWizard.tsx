"use client";
// First-join click-through wizard for map rooms (#80). Shown once per room per
// device (see lib/onboarding). Walks a new guest through the four things that
// make the geospatial silent-disco work on a phone:
//   1. Test audio — the click also unlocks the AudioContext (browsers keep it
//      suspended until a user gesture) and grabs a screen wake lock, so they
//      don't have to tap the map first and can go straight into GPS.
//   2. Audio delay — suggest syncing to a speaker playing out loud at the party.
//   3. GPS — start location and reassure them manual mode exists if it's off.
//   4. iOS note — keep the phone unlocked (the screen is kept on automatically).

import { BluetoothDelayControl } from "@/components/dashboard/BluetoothDelayControl";
import { Button } from "@/components/ui/button";
import { audioContextManager } from "@/lib/audioContextManager";
import { markOnboardingSeen } from "@/lib/onboarding";
import { useMapStore } from "@/store/map";
import { CheckCircle2, Headphones, MapPin, Volume2 } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

// Short pleasant beep so the user can confirm audio actually comes out. Routed
// straight to the destination so it's audible regardless of room volume.
async function playTestTone() {
  await audioContextManager.resume();
  const ctx = audioContextManager.getContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 523.25; // C5
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  osc.start(t);
  osc.stop(t + 0.47);
}

interface OnboardingWizardProps {
  roomId: string;
  onDone: () => void;
}

export function OnboardingWizard({ roomId, onDone }: OnboardingWizardProps) {
  const setLocationMode = useMapStore((s) => s.setLocationMode);
  const [step, setStep] = useState(0);
  const [testedAudio, setTestedAudio] = useState(false);
  const [startedGps, setStartedGps] = useState(false);

  // Build the step list, skipping the iOS note off iOS.
  const showIosStep = isIOS();

  const finish = () => {
    markOnboardingSeen(roomId);
    onDone();
  };

  const steps = [
    {
      icon: <Volume2 className="size-5 text-primary-400" />,
      title: "Test your audio",
      body: (
        <div className="space-y-3">
          <p className="text-sm text-neutral-400">
            Tap below to make sure you can hear sound. This also switches your audio on so you can dive straight into
            the map.
          </p>
          <Button
            type="button"
            variant={testedAudio ? "secondary" : "default"}
            className="w-full"
            onClick={async () => {
              try {
                await playTestTone();
                setTestedAudio(true);
              } catch {
                setTestedAudio(true); // don't trap them if the tone fails
              }
            }}
          >
            {testedAudio ? (
              <>
                <CheckCircle2 className="mr-2 size-4" /> Play again
              </>
            ) : (
              <>
                <Volume2 className="mr-2 size-4" /> Play test sound
              </>
            )}
          </Button>
          {testedAudio && <p className="text-xs text-green-400">Heard it? Turn your volume up and continue.</p>}
        </div>
      ),
      canAdvance: testedAudio,
    },
    {
      icon: <Headphones className="size-5 text-primary-400" />,
      title: "Sync your delay",
      body: (
        <div className="space-y-3">
          <p className="text-sm text-neutral-400">
            Bluetooth earbuds play a moment late. If there&apos;s a speaker playing out loud at the party, nudge this
            until your audio lines up with it.
          </p>
          <div className="rounded-md border border-neutral-800 bg-neutral-950/50">
            <BluetoothDelayControl />
          </div>
        </div>
      ),
      canAdvance: true,
    },
    {
      icon: <MapPin className="size-5 text-primary-400" />,
      title: "Turn on location",
      body: (
        <div className="space-y-3">
          <p className="text-sm text-neutral-400">
            The map plays different music in different spots. Share your location so zones fade in and out as you move.
          </p>
          <Button
            type="button"
            variant={startedGps ? "secondary" : "default"}
            className="w-full"
            onClick={() => {
              setLocationMode("gps");
              setStartedGps(true);
            }}
          >
            {startedGps ? (
              <>
                <CheckCircle2 className="mr-2 size-4" /> Location on
              </>
            ) : (
              <>
                <MapPin className="mr-2 size-4" /> Enable location
              </>
            )}
          </Button>
          <p className="text-xs text-neutral-500">
            If it&apos;s inaccurate, switch to <span className="text-neutral-300">Manual</span> (top-right of the map)
            and tap where you are.
          </p>
        </div>
      ),
      canAdvance: true,
    },
    ...(showIosStep
      ? [
          {
            icon: <MapPin className="size-5 text-primary-400" />,
            title: "Keep your phone awake",
            body: (
              <p className="text-sm text-neutral-400">
                On iPhone, keep this tab open and your phone unlocked for continuous audio. We keep the screen on
                automatically while you&apos;re here.
              </p>
            ),
            canAdvance: true,
          },
        ]
      : []),
  ];

  const current = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-neutral-800">{current.icon}</div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500">
              Step {step + 1} of {steps.length}
            </div>
            <h2 className="text-base font-medium text-white">{current.title}</h2>
          </div>
        </div>

        <div className="min-h-[7rem]">{current.body}</div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-5 bg-primary-500" : "w-1.5 bg-neutral-700"
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={finish} className="text-xs text-neutral-500 hover:text-neutral-300">
            Skip
          </button>
          <Button
            type="button"
            className="rounded-full px-5"
            disabled={!current.canAdvance}
            onClick={() => (isLast ? finish() : setStep((s) => s + 1))}
          >
            {isLast ? "Enter room" : "Next"}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
