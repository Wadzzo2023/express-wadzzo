// src/agent/area.ts
//
// Search areas. A brand's home area is stored like a hotspot: a GeoJSON polygon
// Feature whose ring points are [lat, lng] (the brand app's map-kit format).
// Named places ("Davenport, IA") are turned into a box by geocoding.

export type Box = { south: number; west: number; north: number; east: number };

/** An area to search in, with the polygon when there is one (home areas). */
export type SearchArea = { name: string; box: Box; ring?: [number, number][] };

type StoredFeature = { geometry?: { coordinates?: number[][][] } } | null | undefined;

/** The outer ring of a stored feature as [lat, lng] pairs, if it has one. */
export function ringOf(feature: unknown): [number, number][] | null {
    const ring = (feature as StoredFeature)?.geometry?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;
    const points = ring.filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && p.every((n) => typeof n === "number"));
    return points.length >= 4 ? points.map(([lat, lng]) => [lat, lng]) : null;
}

export function boxOfRing(ring: [number, number][]): Box {
    const lats = ring.map((p) => p[0]);
    const lngs = ring.map((p) => p[1]);
    return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
}

export function areaFromFeature(name: string, feature: unknown): SearchArea | null {
    const ring = ringOf(feature);
    return ring ? { name, box: boxOfRing(ring), ring } : null;
}

/** Ray casting on [lat, lng] points. */
export function inRing(ring: [number, number][], lat: number, lng: number): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [yi, xi] = ring[i]!;
        const [yj, xj] = ring[j]!;
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

export function inArea(area: SearchArea, lat: number, lng: number): boolean {
    const { box } = area;
    if (lat < box.south || lat > box.north || lng < box.west || lng > box.east) return false;
    return area.ring ? inRing(area.ring, lat, lng) : true;
}

/** Splits a box into an n×n grid, to search big areas tile by tile. */
export function tiles(box: Box, n: number): Box[] {
    const dLat = (box.north - box.south) / n;
    const dLng = (box.east - box.west) / n;
    const out: Box[] = [];
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            out.push({ south: box.south + r * dLat, north: box.south + (r + 1) * dLat, west: box.west + c * dLng, east: box.west + (c + 1) * dLng });
        }
    }
    return out;
}

export function centerOf(box: Box) {
    return { lat: (box.south + box.north) / 2, lng: (box.west + box.east) / 2 };
}

export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
    const R = 6_371_000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** A box `radiusKm` around a point. */
export function boxAround(lat: number, lng: number, radiusKm: number): Box {
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

/** Rough size of a box, for deciding how many tiles to search. */
export function boxSpanKm(box: Box): number {
    return Math.max(metresBetween(box.south, box.west, box.north, box.west), metresBetween(box.south, box.west, box.south, box.east)) / 1000;
}
