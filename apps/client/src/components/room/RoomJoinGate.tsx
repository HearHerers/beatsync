"use client";
// One-time "pick your name" gate shown when someone opens a room link without
// having chosen a name yet (the homepage Join form is bypassed on direct links).
// See #68. Once confirmed, the name is persisted and this never shows again.

import { Button } from "@/components/ui/button";
import { generateName } from "@/lib/randomNames";
import { motion } from "motion/react";
import { useState } from "react";

interface RoomJoinGateProps {
  roomId: string;
  initialName: string;
  onJoin: (name: string) => void;
}

export function RoomJoinGate({ roomId, initialName, onJoin }: RoomJoinGateProps) {
  const [name, setName] = useState(initialName);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onJoin(trimmed);
  };

  return (
    <div className="flex h-screen w-full items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl"
      >
        <div>
          <h2 className="text-base font-medium text-white">
            Join room <span className="font-mono text-neutral-400">#{roomId}</span>
          </h2>
          <p className="mt-1 text-xs text-neutral-500">Pick a name so everyone can see who&apos;s here.</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="text"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Your name (spaces ok)"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-white outline-none focus:border-neutral-500"
          />
          <Button
            type="button"
            variant="ghost"
            className="h-8 px-2 text-xs text-neutral-500 hover:text-neutral-300"
            onClick={() => setName(generateName())}
          >
            Regenerate
          </Button>
        </div>
        <Button type="button" className="w-full rounded-full" onClick={submit} disabled={!name.trim()}>
          Join
        </Button>
      </motion.div>
    </div>
  );
}
