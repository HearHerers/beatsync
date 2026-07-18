"use client";
// Leaflet wrapper for map rooms. Owns the L.Map instance, manages draw controls for
// admins, renders shapes from the store, and renders user markers.
//
// All inputs are read from stores (room/mapStore/global). Outputs (shape mutations,
// position updates) are sent via WebSocket using sendWSRequest.

import { useClientId } from "@/hooks/useClientId";
import { useLocalZonePlayback } from "@/hooks/useLocalZonePlayback";
import { emojiForId } from "@/lib/avatarEmoji";
import { getShapeCircle, getShapePolygonRing, outwardOffsetPolygonRing } from "@/lib/geo";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { useRoomStore } from "@/store/room";
import { sendWSRequest } from "@/utils/ws";
import type { MapTileLayerId, ShapeType } from "@beatsync/shared";
import { ClientActionEnum, zoneDisplayName } from "@beatsync/shared";
import L from "leaflet";
import "leaflet-draw";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import { useEffect, useMemo, useRef } from "react";

// Fix Leaflet's default-icon issue under bundlers. Leaflet looks for relative image
// paths that don't exist in a Next bundle; replace with public CDN-served URLs.
const DefaultIcon = L.icon({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

/**
 * Build a "balloon over a precise dot" Leaflet divIcon for a user marker.
 * Layout (top to bottom):
 *   - 28px avatar circle showing the user's creature emoji (#98). Admin gets a
 *     small yellow crown badge in the corner.
 *   - 6px white stem.
 *   - 8px dot anchored at the bottom — this is the geographic anchor point so
 *     dragging keeps the geo position accurate.
 * Total icon: 28 × 44px, anchored at bottom-center.
 */
function buildUserAvatarIcon(opts: { emoji: string; isAdmin: boolean; isSelf: boolean }): L.DivIcon {
  const { emoji, isAdmin, isSelf } = opts;
  const accent = isSelf ? "#22c55e" : "#3b82f6";
  // Defensive escape (emoji come from our own curated set, but never inject raw).
  const safeEmoji = emoji.replace(/[<>&"']/g, "");
  const inner = `<span style="font-size:16px;line-height:1">${safeEmoji}</span>`;

  const crown = isAdmin
    ? `<div style="position:absolute;top:-3px;right:-3px;background:#eab308;border-radius:50%;width:12px;height:12px;display:flex;align-items:center;justify-content:center;border:1px solid #fff">
        <svg width="7" height="7" viewBox="0 0 24 24" fill="#854d0e"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z"/></svg>
      </div>`
    : "";

  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;pointer-events:auto">
      <div style="position:relative;width:28px;height:28px;border-radius:50%;background:${accent};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;overflow:visible">
        <div style="width:100%;height:100%;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center">${inner}</div>
        ${crown}
      </div>
      <div style="width:2px;height:6px;background:#fff;box-shadow:0 0 2px rgba(0,0,0,0.5)"></div>
      <div style="width:8px;height:8px;border-radius:50%;background:#fff;border:1.5px solid ${accent};box-shadow:0 1px 3px rgba(0,0,0,0.6);margin-top:-1px"></div>
    </div>
  `;

  return L.divIcon({
    html,
    iconSize: [28, 44],
    iconAnchor: [14, 44], // bottom-center — the precise dot
    tooltipAnchor: [0, -44],
    className: "",
  });
}

interface MapCanvasProps {
  canMutate: boolean;
}

// Leaflet renders tooltip content strings as HTML, so user-entered zone names
// must be escaped before interpolation.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

// Registry of selectable base maps. `id` is the stable value synced room-wide;
// `label` is what the Leaflet layer switcher shows. "mapbox" only exists when a
// token is configured at build time. Order = display order in the switcher.
//
// maxZoom is 23 everywhere so users can zoom in to street-furniture level for
// precise shape placement; maxNativeZoom marks where each provider's real tiles
// stop, past which Leaflet upscales the nearest tile (pixelated but functional).
const MAP_MAX_ZOOM = 23;
const TILE_LAYERS: { id: MapTileLayerId; label: string; create: () => L.TileLayer }[] = [
  ...(MAPBOX_TOKEN
    ? [
        {
          id: "mapbox" as MapTileLayerId,
          label: "Satellite (Mapbox)",
          // 512px tiles with zoomOffset -1 reach ~z23 natively, so no maxNativeZoom.
          create: () =>
            L.tileLayer(
              `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`,
              { maxZoom: MAP_MAX_ZOOM, tileSize: 512, zoomOffset: -1, attribution: "© Mapbox © Maxar © OpenStreetMap" }
            ),
        },
      ]
    : []),
  {
    id: "esri",
    label: "Satellite (Esri)",
    create: () =>
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: MAP_MAX_ZOOM,
        maxNativeZoom: 19,
        attribution:
          "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
      }),
  },
  {
    id: "michigan",
    label: "Aerial (Michigan)",
    // Michigan statewide hi-res aerial (MiSAIL) — keyless, ~9–12 in/px, native
    // tiles to z19; Michigan-only, Leaflet upscales past z19.
    create: () =>
      L.tileLayer(
        "https://imagery.michigan.gov/server/rest/services/Michigan_imagery_public/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: MAP_MAX_ZOOM,
          maxNativeZoom: 19,
          attribution: "Imagery &copy; State of Michigan (MiSAIL)",
        }
      ),
  },
  {
    id: "street",
    label: "Street",
    create: () =>
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: MAP_MAX_ZOOM,
        maxNativeZoom: 19,
        attribution: "© OpenStreetMap contributors",
      }),
  },
];

// Default when no room default is set: Mapbox if available (sharpest), else Esri.
const BUILD_DEFAULT_TILE_ID: MapTileLayerId = MAPBOX_TOKEN ? "mapbox" : "esri";

// Resolve a (possibly stale/unavailable) id to one that actually exists in this
// build — e.g. a room defaulting to "mapbox" on a deployment without a token.
function resolveTileLayerId(id: MapTileLayerId | undefined): MapTileLayerId {
  return id && TILE_LAYERS.some((t) => t.id === id) ? id : BUILD_DEFAULT_TILE_ID;
}

export const MapCanvas = ({ canMutate }: MapCanvasProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const drawControlRef = useRef<L.Control.Draw | null>(null);
  // Map shape.id → the Leaflet layer that renders it.
  const shapeLayersRef = useRef<Map<string, L.Layer>>(new Map());
  // Map shape.id → the dashed "halo" layer that visualizes that shape's
  // falloff range. Only present for the currently-selected shape.
  const haloLayersRef = useRef<Map<string, L.Path>>(new Map());
  // Map clientId → marker layer for other users.
  const otherMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  // Single marker for the current client.
  const ownMarkerRef = useRef<L.Marker | null>(null);
  const isDraggingOwnRef = useRef(false);
  // Base-map layers keyed by id, and the id currently shown — used to apply the
  // room default and to know what an admin's "set as room default" broadcasts.
  const layersByIdRef = useRef<Partial<Record<MapTileLayerId, L.TileLayer>>>({});
  const activeTileLayerIdRef = useRef<MapTileLayerId>(BUILD_DEFAULT_TILE_ID);
  const layersControlRef = useRef<L.Control.Layers | null>(null);

  const mapMetadata = useRoomStore((s) => s.mapMetadata);
  const defaultTileLayerId = useRoomStore((s) => s.defaultTileLayerId);
  const connectedClients = useGlobalStore((s) => s.connectedClients);
  const shapes = useMapStore((s) => s.shapes);
  const selectedShapeId = useMapStore((s) => s.selectedShapeId);
  const ownPosition = useMapStore((s) => s.ownPosition);
  const setOwnPosition = useMapStore((s) => s.setOwnPosition);
  const pendingRecenter = useMapStore((s) => s.pendingRecenter);
  const { clientId: myClientId } = useClientId();
  // Per-zone local audio state — drives the amber "still downloading" and
  // gray "not downloaded here yet" tints (compared against each zone's
  // current track from playlists).
  const localStates = useLocalZonePlayback();
  const playlists = useGlobalStore((s) => s.playlists);

  // Keep Leaflet's internal size cache in sync with the container. Required
  // when the panel surrounding the map is resized or collapsed/expanded —
  // without it the tile grid stays at its old dimensions and renders gaps.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      mapRef.current?.invalidateSize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Initialize Leaflet map once ────────────────────────────────
  // This effect MUST NOT depend on canMutate — re-running it tears down the
  // map (and all shape layers) without re-firing the shape-render effect,
  // leaving the user with an empty map after admin promotion. Draw control
  // toggling lives in its own effect below.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const center: L.LatLngTuple = mapMetadata?.center ?? [42.2808, -83.743];
    const zoom = mapMetadata?.zoom ?? 17;

    // Allow zooming to z=23 (street-furniture-level) even though tile providers
    // only ship native imagery up to z=19. Leaflet upscales the nearest-available
    // native tile past that — pixelated but functional — which is exactly what
    // we want for placing shapes precisely (e.g. tracing a single bench).
    const map = L.map(containerRef.current, { zoomControl: true, maxZoom: MAP_MAX_ZOOM }).setView(center, zoom);

    // Build the base-map layers from the registry. Satellite is the natural
    // default for picking out buildings/paths/lawns when curating zones; the
    // others (incl. Street) are offered in the layer switcher.
    const layersById: Partial<Record<MapTileLayerId, L.TileLayer>> = {};
    const baseLayers: Record<string, L.TileLayer> = {};
    const labelToId: Record<string, MapTileLayerId> = {};
    for (const def of TILE_LAYERS) {
      const layer = def.create();
      layersById[def.id] = layer;
      baseLayers[def.label] = layer;
      labelToId[def.label] = def.id;
    }
    layersByIdRef.current = layersById;

    // Show the room's saved default if present (else the build default). The
    // default may also arrive after init — the effect below handles that.
    const initialId = resolveTileLayerId(useRoomStore.getState().defaultTileLayerId);
    layersById[initialId]?.addTo(map);
    activeTileLayerIdRef.current = initialId;

    layersControlRef.current = L.control.layers(baseLayers, undefined, { position: "topright" }).addTo(map);

    // Track local layer switches so the admin "set as room default" button knows
    // the current selection.
    map.on("baselayerchange", (e: L.LayersControlEvent) => {
      const id = labelToId[e.name];
      if (id) activeTileLayerIdRef.current = id;
    });

    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Manual-mode drag: clicking the map sets the user's position. (For phones,
    // the GPS path also flows through setOwnPosition once permission is granted.)
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (useMapStore.getState().locationMode !== "manual") return;
      setOwnPosition({ lat: e.latlng.lat, lng: e.latlng.lng });
      const ws = useGlobalStore.getState().socket;
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendWSRequest({
          ws,
          request: {
            type: ClientActionEnum.enum.SET_GEO_POSITION,
            lat: e.latlng.lat,
            lng: e.latlng.lng,
          },
        });
      }
    });

    drawnItemsRef.current = drawnItems;
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      drawnItemsRef.current = null;
      drawControlRef.current = null;
      shapeLayersRef.current.clear();
      otherMarkersRef.current.clear();
      ownMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Apply the room-wide default tile layer ─────────────────────────
  // Fires when an admin broadcasts a new default (DEFAULT_TILE_LAYER_UPDATE) or
  // when the saved default arrives on connect. Switches every client's active
  // base layer; users can still re-pick locally via the layer switcher.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !defaultTileLayerId) return;
    const targetId = resolveTileLayerId(defaultTileLayerId);
    const target = layersByIdRef.current[targetId];
    if (!target || map.hasLayer(target)) return;
    for (const layer of Object.values(layersByIdRef.current)) {
      if (layer && layer !== target && map.hasLayer(layer)) map.removeLayer(layer);
    }
    map.addLayer(target);
    activeTileLayerIdRef.current = targetId;
  }, [defaultTileLayerId]);

  // ── Admin-only "set as room default" button (inside the layer chooser) ──
  // Injected into the layer switcher's expandable list, so it only shows when an
  // admin opens the chooser. Lets them push their current base map to everyone.
  // Added/removed with canMutate (e.g. on admin promotion).
  useEffect(() => {
    if (!canMutate) return;
    const list = layersControlRef.current?.getContainer()?.querySelector(".leaflet-control-layers-list");
    if (!list) return;

    const separator = L.DomUtil.create("div", "leaflet-control-layers-separator", list as HTMLElement);
    const wrap = L.DomUtil.create("div", "", list as HTMLElement);
    const btn = L.DomUtil.create("button", "", wrap) as HTMLButtonElement;
    btn.type = "button";
    btn.textContent = "Set as room default";
    btn.title = "Make the current base map the room default for everyone";
    btn.style.cssText =
      "display:block;width:100%;padding:4px 6px;font-size:11px;line-height:1.2;cursor:pointer;" +
      "border:1px solid #ccc;border-radius:3px;background:#f4f4f4;color:#222;";
    L.DomEvent.disableClickPropagation(wrap);
    L.DomEvent.on(btn, "click", (ev) => {
      L.DomEvent.preventDefault(ev);
      const ws = useGlobalStore.getState().socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      sendWSRequest({
        ws,
        request: {
          type: ClientActionEnum.enum.SET_DEFAULT_TILE_LAYER,
          tileLayerId: activeTileLayerIdRef.current,
        },
      });
      btn.textContent = "✓ Set for everyone";
      setTimeout(() => {
        btn.textContent = "Set as room default";
      }, 1500);
    });

    return () => {
      separator.remove();
      wrap.remove();
    };
  }, [canMutate]);

  // ── Add/remove the draw control when admin status changes ──────
  // Keeps the same L.Map instance — only the control and its event handlers
  // come and go with canMutate. Shape layers and other state are preserved.
  useEffect(() => {
    const map = mapRef.current;
    const drawnItems = drawnItemsRef.current;
    if (!map || !drawnItems || !canMutate) return;

    const drawControl = new L.Control.Draw({
      edit: { featureGroup: drawnItems, remove: true },
      draw: {
        polygon: { allowIntersection: false, showArea: false },
        rectangle: {},
        circle: {},
        circlemarker: false,
        marker: false,
        polyline: false,
      },
    });
    map.addControl(drawControl);
    drawControlRef.current = drawControl;

    const onCreated = (event: L.LeafletEvent) => {
      const e = event as L.DrawEvents.Created;
      const layer = e.layer;
      const id =
        (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
        `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      let coordinates: unknown;
      if (e.layerType === "circle" && layer instanceof L.Circle) {
        const c = layer.getLatLng();
        coordinates = { center: [c.lat, c.lng], radius: layer.getRadius() };
      } else if (layer instanceof L.Polygon) {
        coordinates = (layer.getLatLngs() as L.LatLng[][]).map((ring) => ring.map((pt) => [pt.lat, pt.lng]));
      } else {
        return;
      }

      const ws = useGlobalStore.getState().socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      sendWSRequest({
        ws,
        request: {
          type: ClientActionEnum.enum.ADD_SHAPE,
          shape: {
            id,
            type: e.layerType,
            coordinates,
            createdBy: myClientId ?? "anonymous",
            createdAt: Date.now(),
            groupId: null,
            falloffMeters: 25,
          },
        },
      });
      // Don't add the layer locally — the server's SHAPES_UPDATE will broadcast it
      // back and our shape-render effect will draw it. This keeps the visual state
      // single-sourced from the store.
    };

    const onDeleted = (event: L.LeafletEvent) => {
      const e = event as L.DrawEvents.Deleted;
      const ws = useGlobalStore.getState().socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      e.layers.eachLayer((layer) => {
        for (const [id, l] of shapeLayersRef.current.entries()) {
          if (l === layer) {
            sendWSRequest({
              ws,
              request: { type: ClientActionEnum.enum.DELETE_SHAPE, shapeId: id },
            });
            break;
          }
        }
      });
    };

    const onEdited = (event: L.LeafletEvent) => {
      const e = event as L.DrawEvents.Edited;
      const ws = useGlobalStore.getState().socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      e.layers.eachLayer((layer) => {
        let shapeId: string | undefined;
        for (const [id, l] of shapeLayersRef.current.entries()) {
          if (l === layer) {
            shapeId = id;
            break;
          }
        }
        if (!shapeId) return;
        let coordinates: unknown;
        if (layer instanceof L.Circle) {
          const c = layer.getLatLng();
          coordinates = { center: [c.lat, c.lng], radius: layer.getRadius() };
        } else if (layer instanceof L.Polygon) {
          coordinates = (layer.getLatLngs() as L.LatLng[][]).map((ring) => ring.map((pt) => [pt.lat, pt.lng]));
        } else {
          return;
        }
        sendWSRequest({
          ws,
          request: { type: ClientActionEnum.enum.UPDATE_SHAPE, shapeId, coordinates },
        });
      });
    };

    map.on(L.Draw.Event.CREATED, onCreated);
    map.on(L.Draw.Event.DELETED, onDeleted);
    map.on(L.Draw.Event.EDITED, onEdited);

    return () => {
      map.off(L.Draw.Event.CREATED, onCreated);
      map.off(L.Draw.Event.DELETED, onDeleted);
      map.off(L.Draw.Event.EDITED, onEdited);
      map.removeControl(drawControl);
      drawControlRef.current = null;
    };
  }, [canMutate, myClientId]);

  // Re-center when mapMetadata changes (curator hit "Set map view").
  useEffect(() => {
    if (mapRef.current && mapMetadata) {
      mapRef.current.setView(mapMetadata.center, mapMetadata.zoom);
    }
  }, [mapMetadata]);

  // Center on the user's own position when requested (#66 GPS-switch, #67 button).
  // Waits until a position is actually available — arming the request before the
  // first GPS fix lands is fine; this fires as soon as ownPosition appears.
  useEffect(() => {
    const map = mapRef.current;
    if (!pendingRecenter || !map || !ownPosition) return;
    // Two MapCanvas instances are mounted at once (desktop + mobile layouts;
    // the inactive one is display:none, so its map is 0×0). flyTo on a
    // zero-size map divides by zero in Leaflet's flight math and throws
    // "Invalid LatLng (NaN, NaN)", crashing the app. Skip without consuming
    // so the visible instance handles the recenter instead.
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return;
    map.flyTo([ownPosition.lat, ownPosition.lng], Math.max(map.getZoom(), 18), { duration: 0.6 });
    useMapStore.getState().consumeRecenter();
  }, [pendingRecenter, ownPosition]);

  // ── Sync shapes → Leaflet layers ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const group = drawnItemsRef.current;
    if (!map || !group) return;

    const seen = new Set<string>();
    for (const shape of shapes.values()) {
      seen.add(shape.id);
      let layer = shapeLayersRef.current.get(shape.id);
      const coords = shape.coordinates as unknown;

      // Decide if existing layer is still right-typed, else remove + recreate.
      const isCircleCoords = coords && typeof coords === "object" && "center" in coords && "radius" in coords;
      const wantsCircle = !!isCircleCoords;
      const isCircle = layer instanceof L.Circle;

      if (layer && wantsCircle !== isCircle) {
        group.removeLayer(layer);
        layer = undefined;
      }

      if (!layer) {
        if (wantsCircle) {
          const { center, radius } = coords as { center: [number, number]; radius: number };
          layer = L.circle(center as L.LatLngTuple, {
            radius,
            color: "#22c55e",
            fillOpacity: 0.15,
          });
        } else if (Array.isArray(coords)) {
          layer = L.polygon(coords as L.LatLngExpression[][], {
            color: "#22c55e",
            fillOpacity: 0.15,
          });
        } else {
          continue;
        }
        group.addLayer(layer);
        shapeLayersRef.current.set(shape.id, layer);
        // Click on a shape selects it for the playlist panel; clicking the
        // already-selected shape deselects. Capture by id; the store call is
        // read fresh so this doesn't go stale when the selection changes.
        layer.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          const map = useMapStore.getState();
          map.setSelectedShapeId(map.selectedShapeId === shape.id ? null : shape.id);
        });
      } else if (layer instanceof L.Circle && wantsCircle) {
        const { center, radius } = coords as { center: [number, number]; radius: number };
        layer.setLatLng(center as L.LatLngTuple);
        layer.setRadius(radius);
      } else if (layer instanceof L.Polygon && Array.isArray(coords)) {
        layer.setLatLngs(coords as L.LatLngExpression[][]);
      }

      // Tooltip shows the zone name (same fallback rule as the shape panel);
      // playlist details (track count, play state) are visible in the side
      // panel that hosts the Queue/Player UI. Names are user-entered and
      // Leaflet renders tooltip strings as HTML, so escape them.
      const tooltipLabel = escapeHtml(zoneDisplayName(shape));
      layer.bindTooltip(`<div class="text-xs"><strong>${tooltipLabel}</strong></div>`, {
        permanent: false,
        direction: "top",
      });
    }

    // Remove layers for shapes that no longer exist.
    for (const [id, layer] of shapeLayersRef.current.entries()) {
      if (!seen.has(id)) {
        group.removeLayer(layer);
        shapeLayersRef.current.delete(id);
      }
    }
  }, [shapes]);

  // ── Highlight the selected shape + local load state ─────────────
  // Color precedence: selected (yellow) > audio still loading on THIS device
  // (amber) > has audio but not downloaded here yet (gray) > ready/empty
  // (green). Gray answers "will this play instantly if I walk in?" — a
  // late-joiner sees every zone gray until its track is buffered (walk-in or
  // Preload), then green. Zones with no tracks stay green: there is nothing to
  // download, so gray would be noise. Loading amber matches the bottom-bar and
  // zone-header indicators; the selected zone stays yellow because the side
  // panel already shows its load state in detail.
  useEffect(() => {
    for (const [id, layer] of shapeLayersRef.current.entries()) {
      if (!(layer instanceof L.Path)) continue;
      const isSelected = id === selectedShapeId;
      const info = localStates.get(id);
      const isLoading = info?.state === "loading";
      // The track a walk-in would play: the scheduled one, else the queue head
      // (same rule as preloadAllZones). Unloaded = that track isn't the one
      // buffered — covers no-chain-yet AND a stale buffer after a track change.
      const playlist = playlists.get(id);
      const entryUrl = playlist ? playlist.playbackState.audioSource || playlist.tracks[0]?.url : undefined;
      const isUnloaded = !!entryUrl && !isLoading && info?.bufferedUrl !== entryUrl;
      layer.setStyle({
        color: isSelected ? "#fde047" : isLoading ? "#f59e0b" : isUnloaded ? "#9ca3af" : "#22c55e",
        weight: isSelected ? 3 : 2,
        fillOpacity: isSelected ? 0.25 : isLoading ? 0.2 : isUnloaded ? 0.1 : 0.15,
      });
    }
  }, [selectedShapeId, shapes, localStates, playlists]);

  // ── Falloff halos for every shape ───────────────────────────────
  // Visualizes each shape's audio falloff as a dashed outline at the falloff
  // distance past the shape's edge. The selected shape's halo uses the same
  // yellow accent as its outline; others use the green accent. Halos are
  // non-interactive so clicks still pass through to the shape underneath.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const haloStyle = (isSelected: boolean): L.PathOptions => ({
      color: isSelected ? "#fde047" : "#22c55e",
      weight: 1.5,
      opacity: isSelected ? 0.9 : 0.55,
      fillColor: isSelected ? "#fde047" : "#22c55e",
      fillOpacity: isSelected ? 0.06 : 0.03,
      dashArray: "4 4",
      interactive: false,
    });

    const seen = new Set<string>();

    for (const shape of shapes.values()) {
      if (shape.falloffMeters <= 0) continue; // hard cutoff — nothing to draw
      const isSelected = shape.id === selectedShapeId;
      const style = haloStyle(isSelected);

      const circle = getShapeCircle(shape);
      const ring = getShapePolygonRing(shape);
      let halo: L.Path | undefined;
      if (circle) {
        halo = L.circle([circle.center.lat, circle.center.lng], {
          radius: circle.radius + shape.falloffMeters,
          ...style,
        });
      } else if (ring) {
        const outer = outwardOffsetPolygonRing(ring, shape.falloffMeters);
        halo = L.polygon(
          outer.map((p) => [p.lat, p.lng] as L.LatLngTuple),
          style
        );
      }
      if (!halo) continue;

      // Replace the prior halo wholesale — simpler than trying to mutate
      // geometry + style in place across all shape types.
      const existing = haloLayersRef.current.get(shape.id);
      if (existing) map.removeLayer(existing);
      halo.addTo(map);
      haloLayersRef.current.set(shape.id, halo);
      seen.add(shape.id);
    }

    // Drop halos whose shape was removed or whose falloff went to 0.
    for (const [id, halo] of haloLayersRef.current.entries()) {
      if (!seen.has(id)) {
        map.removeLayer(halo);
        haloLayersRef.current.delete(id);
      }
    }
  }, [selectedShapeId, shapes]);

  // ── Sync other users' markers ──────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const myId = myClientId;
    const seen = new Set<string>();

    for (const client of connectedClients) {
      if (client.clientId === myId) continue;
      if (!client.geoPosition) continue;
      seen.add(client.clientId);
      const existing = otherMarkersRef.current.get(client.clientId);
      const pos: L.LatLngTuple = [client.geoPosition.lat, client.geoPosition.lng];
      const icon = buildUserAvatarIcon({
        emoji: emojiForId(client.clientId),
        isAdmin: !!client.isAdmin,
        isSelf: false,
      });
      const label = client.username || client.clientId;
      if (existing) {
        existing.setLatLng(pos);
        // Rebuild icon + tooltip on every render — handles username changes,
        // admin promotion, flag becoming available after IP geo resolves.
        existing.setIcon(icon);
        existing.unbindTooltip();
        existing.bindTooltip(label, { direction: "top" });
      } else {
        const marker = L.marker(pos, { icon });
        marker.bindTooltip(label, { direction: "top" });
        marker.addTo(map);
        otherMarkersRef.current.set(client.clientId, marker);
      }
    }
    for (const [id, marker] of otherMarkersRef.current.entries()) {
      if (!seen.has(id)) {
        map.removeLayer(marker);
        otherMarkersRef.current.delete(id);
      }
    }
  }, [connectedClients, myClientId]);

  // ── Own marker: render + drag handling ─────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!ownPosition) {
      if (ownMarkerRef.current) {
        map.removeLayer(ownMarkerRef.current);
        ownMarkerRef.current = null;
      }
      return;
    }

    const pos: L.LatLngTuple = [ownPosition.lat, ownPosition.lng];
    const me = connectedClients.find((c) => c.clientId === myClientId);
    const selfIcon = buildUserAvatarIcon({
      emoji: emojiForId(myClientId),
      isAdmin: !!me?.isAdmin,
      isSelf: true,
    });
    const selfLabel = me?.username || "You";
    if (ownMarkerRef.current) {
      // During a drag, Leaflet owns the marker's DOM element + position. This
      // effect still re-runs every drag frame (ownPosition updates via the
      // "drag" handler below), but rebuilding the avatar icon and calling
      // setIcon recreates that element — incl. the <img> flag — which janks and
      // fights the drag handler's pointer tracking. Skip all marker mutation
      // until the drag ends; a later ownPosition/clients change re-syncs it.
      if (!isDraggingOwnRef.current) {
        ownMarkerRef.current.setLatLng(pos);
        ownMarkerRef.current.setIcon(selfIcon);
        ownMarkerRef.current.unbindTooltip();
        ownMarkerRef.current.bindTooltip(selfLabel, { direction: "top" });
      }
    } else {
      const marker = L.marker(pos, { draggable: true, icon: selfIcon });
      marker.bindTooltip(selfLabel, { direction: "top" });
      marker.on("dragstart", () => {
        isDraggingOwnRef.current = true;
      });
      marker.on("drag", (e: L.LeafletEvent) => {
        const m = e.target as L.Marker;
        const p = m.getLatLng();
        setOwnPosition({ lat: p.lat, lng: p.lng });
      });
      marker.on("dragend", () => {
        isDraggingOwnRef.current = false;
        const p = marker.getLatLng();
        const ws = useGlobalStore.getState().socket;
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendWSRequest({
            ws,
            request: { type: ClientActionEnum.enum.SET_GEO_POSITION, lat: p.lat, lng: p.lng },
          });
        }
      });
      marker.addTo(map);
      ownMarkerRef.current = marker;
    }
  }, [ownPosition, setOwnPosition, connectedClients, myClientId]);

  return <div ref={containerRef} className="absolute inset-0 z-0" style={{ width: "100%", height: "100%" }} />;
};

/** Compute "is my client an admin in this room?" from the connectedClients list. */
export function useCanMutate(): boolean {
  const connectedClients = useGlobalStore((s) => s.connectedClients);
  const { clientId } = useClientId();
  return useMemo(() => {
    const me = connectedClients.find((c) => c.clientId === clientId);
    return !!me?.isAdmin;
  }, [connectedClients, clientId]);
}

export type { ShapeType };
