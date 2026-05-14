"use client";
// Leaflet wrapper for map rooms. Owns the L.Map instance, manages draw controls for
// admins, renders shapes from the store, and renders user markers.
//
// All inputs are read from stores (room/mapStore/global). Outputs (shape mutations,
// position updates) are sent via WebSocket using sendWSRequest.

import { useClientId } from "@/hooks/useClientId";
import { getShapeCircle, getShapePolygonRing, outwardOffsetPolygonRing } from "@/lib/geo";
import { useGlobalStore } from "@/store/global";
import { useMapStore } from "@/store/map";
import { useRoomStore } from "@/store/room";
import { sendWSRequest } from "@/utils/ws";
import type { ShapeType } from "@beatsync/shared";
import { ClientActionEnum } from "@beatsync/shared";
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
 *   - 28px avatar circle (country flag if available, else two-letter initials).
 *     Admin gets a small yellow crown badge in the corner.
 *   - 6px white stem.
 *   - 8px dot anchored at the bottom — this is the geographic anchor point so
 *     dragging keeps the geo position accurate.
 * Total icon: 28 × 44px, anchored at bottom-center.
 */
function buildUserAvatarIcon(opts: {
  username: string;
  flagUrl?: string;
  isAdmin: boolean;
  isSelf: boolean;
}): L.DivIcon {
  const { username, flagUrl, isAdmin, isSelf } = opts;
  const accent = isSelf ? "#22c55e" : "#3b82f6";
  const initials = username
    .split(/[-\s]+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // Escape HTML in user-controlled strings (the flag URL comes from our own
  // IP-geo helper so it's safer, but be defensive on the username initials).
  const safeInitials = initials.replace(/[<>&"']/g, "");
  const safeFlagUrl = flagUrl?.replace(/[<>"']/g, "");

  const inner = safeFlagUrl
    ? `<img src="${safeFlagUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.parentElement.innerHTML='<span style=color:white;font-size:11px;font-weight:600;letter-spacing:0.5px>${safeInitials}</span>';this.parentElement.style.background='${accent}'" />`
    : `<span style="color:#fff;font-size:11px;font-weight:600;letter-spacing:0.5px">${safeInitials}</span>`;

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

  const mapMetadata = useRoomStore((s) => s.mapMetadata);
  const connectedClients = useGlobalStore((s) => s.connectedClients);
  const shapes = useMapStore((s) => s.shapes);
  const selectedShapeId = useMapStore((s) => s.selectedShapeId);
  const ownPosition = useMapStore((s) => s.ownPosition);
  const setOwnPosition = useMapStore((s) => s.setOwnPosition);
  const { clientId: myClientId } = useClientId();

  // ── Initialize Leaflet map once ────────────────────────────────
  // This effect MUST NOT depend on canMutate — re-running it tears down the
  // map (and all shape layers) without re-firing the shape-render effect,
  // leaving the user with an empty map after admin promotion. Draw control
  // toggling lives in its own effect below.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const center: L.LatLngTuple = mapMetadata?.center ?? [42.2808, -83.743];
    const zoom = mapMetadata?.zoom ?? 17;

    const map = L.map(containerRef.current, { zoomControl: true }).setView(center, zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);

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
        rectangle: false, // duplicates polygon for our purposes
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
        // Click on a shape selects it for the playlist panel. Capture by id;
        // the store call is read fresh so this doesn't go stale when the
        // selection changes.
        layer.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          useMapStore.getState().setSelectedShapeId(shape.id);
        });
      } else if (layer instanceof L.Circle && wantsCircle) {
        const { center, radius } = coords as { center: [number, number]; radius: number };
        layer.setLatLng(center as L.LatLngTuple);
        layer.setRadius(radius);
      } else if (layer instanceof L.Polygon && Array.isArray(coords)) {
        layer.setLatLngs(coords as L.LatLngExpression[][]);
      }

      // Tooltip shows the shape id; playlist details (track count, play state)
      // are visible in the side panel that hosts the Queue/Player UI.
      layer.bindTooltip(`<div class="text-xs"><strong>${shape.id.slice(0, 6)}</strong></div>`, {
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

  // ── Highlight the selected shape ────────────────────────────────
  useEffect(() => {
    for (const [id, layer] of shapeLayersRef.current.entries()) {
      const isSelected = id === selectedShapeId;
      if (layer instanceof L.Path) {
        layer.setStyle({
          color: isSelected ? "#fde047" : "#22c55e",
          weight: isSelected ? 3 : 2,
          fillOpacity: isSelected ? 0.25 : 0.15,
        });
      }
    }
  }, [selectedShapeId, shapes]);

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
        username: client.username,
        flagUrl: client.location?.flagSvgURL,
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
      username: me?.username ?? "You",
      flagUrl: me?.location?.flagSvgURL,
      isAdmin: !!me?.isAdmin,
      isSelf: true,
    });
    const selfLabel = me?.username || "You";
    if (ownMarkerRef.current) {
      if (!isDraggingOwnRef.current) ownMarkerRef.current.setLatLng(pos);
      ownMarkerRef.current.setIcon(selfIcon);
      ownMarkerRef.current.unbindTooltip();
      ownMarkerRef.current.bindTooltip(selfLabel, { direction: "top" });
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
