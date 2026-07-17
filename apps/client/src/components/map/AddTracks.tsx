"use client";
// Compact "add tracks" control for a playlist: one tab strip over
// Search / Upload / URL so the three add-methods don't stack. All three route
// into the same playlist via `contextId` (a zone shape.id, or omitted for the
// room-wide pool / main context).

import { AudioUploaderMinimal } from "@/components/AudioUploaderMinimal";
import { InlineSearch } from "@/components/dashboard/InlineSearch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AddTracksProps {
  /** Target playlist; omitted = the room-wide main context (pool / audio room). */
  contextId?: string;
  /** Uploader title (e.g. "Upload to <zone>"). */
  label?: string;
  /** Destination noun for the pool ("Room Pool") — drives the upload/URL copy. */
  destination?: string;
  /** Render search results in document flow (single-scroll panel) rather than
   * as a floating overlay. See InlineSearch. */
  inlineResults?: boolean;
}

export function AddTracks({ contextId, label, destination, inlineResults }: AddTracksProps) {
  return (
    <Tabs defaultValue="search" className="flex flex-col gap-2">
      <TabsList className="h-7 w-full">
        <TabsTrigger value="search" className="text-[11px]">
          Search
        </TabsTrigger>
        <TabsTrigger value="upload" className="text-[11px]">
          Upload
        </TabsTrigger>
        <TabsTrigger value="url" className="text-[11px]">
          URL
        </TabsTrigger>
      </TabsList>

      <TabsContent value="search" className="data-[state=inactive]:hidden">
        <InlineSearch contextId={contextId} inlineResults={inlineResults} />
      </TabsContent>
      <TabsContent value="upload" className="data-[state=inactive]:hidden">
        <AudioUploaderMinimal contextId={contextId} label={label} destination={destination} only="upload" />
      </TabsContent>
      <TabsContent value="url" className="data-[state=inactive]:hidden">
        <AudioUploaderMinimal contextId={contextId} destination={destination} only="url" />
      </TabsContent>
    </Tabs>
  );
}
