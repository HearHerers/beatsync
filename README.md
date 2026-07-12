# HearHere

A geospatial silent disco app.

The host draws sound zones on a real-world map, and as you walk (or dance) in and out of different zones, the sounds update based on your location.

Built on [Beatsync](https://github.com/freeman-jiang/beatsync), a high-precision web audio sync engine, as the audio backend — [NTP-inspired](https://en.wikipedia.org/wiki/Network_Time_Protocol) time synchronization keeps playback millisecond-accurate across every device in the room.

## How it works

- **Map rooms**: A host draws zones (circles and polygons) on a shared map and assigns a sound to each
- **GPS-driven audio**: Your phone's location determines what you hear — cross a zone boundary and the mix changes, with proximity-based gain near edges
- **Synchronized playback**: Everyone in the same zone hears the same audio at the same moment
- **Runs in the browser**: No app install — works on any device with a modern browser (Chrome recommended)

## Quickstart

This project uses [Turborepo](https://turbo.build/repo).

Fill in the `.env` file in `apps/client`:

```sh
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws
```

Then start the server and client:

```sh
bun install          # installs once for all workspaces
bun dev              # starts both client (:3000) and server (:8080)
```

| Directory         | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `apps/server`     | Bun HTTP + WebSocket server                                    |
| `apps/client`     | Next.js frontend with Tailwind & Shadcn/ui                     |
| `packages/shared` | Type-safe schemas and functions shared between client & server |
