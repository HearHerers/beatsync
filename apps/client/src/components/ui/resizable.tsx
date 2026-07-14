"use client";

import { cn } from "@/lib/utils";
import { GripHorizontal, GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";

const ResizablePanelGroup = ({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof Group>) => (
  <Group
    orientation={orientation}
    className={cn("flex h-full w-full", orientation === "vertical" && "flex-col", className)}
    {...props}
  />
);

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle,
  orientation = "horizontal",
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
  /** Match the parent Group's orientation. "horizontal" → vertical bar; "vertical" → horizontal bar. */
  orientation?: "horizontal" | "vertical";
}) => {
  const isHorizontalGroup = orientation === "horizontal";
  return (
    <Separator
      className={cn(
        "relative flex items-center justify-center bg-neutral-800/60 transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        isHorizontalGroup
          ? "w-px after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2"
          : "h-px after:absolute after:inset-x-0 after:top-1/2 after:h-1 after:-translate-y-1/2",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div
          className={cn(
            "z-10 flex items-center justify-center rounded-sm border border-neutral-700 bg-neutral-900",
            isHorizontalGroup ? "h-4 w-3" : "h-3 w-4"
          )}
        >
          {isHorizontalGroup ? (
            <GripVertical className="h-2.5 w-2.5 text-neutral-400" />
          ) : (
            <GripHorizontal className="h-2.5 w-2.5 text-neutral-400" />
          )}
        </div>
      )}
    </Separator>
  );
};

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
