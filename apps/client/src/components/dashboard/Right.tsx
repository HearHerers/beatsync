import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { MessageCircle, Rotate3D, Settings } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { ConnectedUsersList } from "./ConnectedUsersList";
import { Chat } from "./right/Chat";
import { SettingsPanel } from "./SettingsPanel";
import { SpatialAudio } from "./right/SpatialAudio";

interface RightProps {
  /** When true, drops the Spatial + Settings tabs and renders Chat full-height.
   *  Used by map rooms, which have their own dedicated Settings panel and no
   *  grid-based spatial audio (proximity comes from GPS). */
  chatOnly?: boolean;
  /** Overrides the wrapper className — used by map rooms to drop the fixed
   *  `lg:w-80` so the panel can fill its resizable container. */
  className?: string;
}

// The connected-users list now lives at the top of the chat panel (#93 — the
// left sidebar that used to host it is gone). Bounded height so it never
// crowds out the messages.
const UsersStrip = () => (
  <div className="max-h-44 flex-shrink-0 overflow-y-auto border-b border-neutral-800/50">
    <ConnectedUsersList />
  </div>
);

export const Right = ({ chatOnly = false, className }: RightProps = {}) => {
  if (chatOnly) {
    return (
      <div
        className={cn(
          "w-full lg:w-80 lg:flex-shrink-0 border-l border-neutral-800/50 bg-neutral-900/50 backdrop-blur-md flex flex-col h-full min-h-0",
          className
        )}
      >
        <UsersStrip />
        <div className="flex-1 overflow-hidden min-h-0">
          <Chat />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-full lg:w-80 lg:flex-shrink-0 border-l border-neutral-800/50 bg-neutral-900/50 backdrop-blur-md flex flex-col h-full min-h-0",
        className
      )}
    >
      <UsersStrip />
      <Tabs defaultValue="chat" className="flex flex-col h-full min-h-0">
        <div className="p-2 pb-0 flex-shrink-0">
          <TabsList className="bg-neutral-900 w-full">
            <TabsTrigger value="chat" className="flex-1">
              <MessageCircle className="h-3.5 w-3.5 mr-1.5" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="spatial" className="flex-1">
              <Rotate3D className="h-3.5 w-3.5 mr-1.5" />
              Spatial
            </TabsTrigger>
            <TabsTrigger value="settings" className="flex-1">
              <Settings className="h-3.5 w-3.5 mr-1.5" />
              Settings
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="relative">
          <Separator className="bg-neutral-800/50" />
        </div>
        <TabsContent value="chat" className="flex-1 overflow-hidden h-full min-h-0">
          <Chat />
        </TabsContent>
        <TabsContent value="spatial" className="flex-1 overflow-auto h-full min-h-0">
          <ScrollArea className="h-full">
            <SpatialAudio />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="settings" className="flex-1 overflow-auto h-full min-h-0">
          <SettingsPanel className="h-full" />
        </TabsContent>
      </Tabs>
    </div>
  );
};
