import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { AudioUploaderMinimal } from "../AudioUploaderMinimal";
import { Queue } from "../Queue";
import { InlineSearch } from "./InlineSearch";

export const Main = () => {
  return (
    <motion.div
      className={cn(
        "w-full lg:flex-1 overflow-y-auto bg-gradient-to-b from-neutral-900/90 to-neutral-950 backdrop-blur-xl bg-neutral-950 h-full",
        "scrollbar-thin scrollbar-thumb-rounded-md scrollbar-thumb-muted-foreground/10 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground/20"
      )}
    >
      <motion.div className="p-6 pt-4">
        <div className="mb-6">
          <InlineSearch />
        </div>
        <Queue className="mb-6" />
        {/* Upload lives here now that the left sidebar is gone (#93). */}
        <AudioUploaderMinimal />
      </motion.div>
    </motion.div>
  );
};
