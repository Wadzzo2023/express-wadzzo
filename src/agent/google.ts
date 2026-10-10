// src/agent/google.ts
//
// Google Geocoding + Places (New) Text Search. Results are cached (geo-cache.ts).
// Searches are restricted to a box, so "parks" in a brand's home area never
// returns parks elsewhere; big boxes are searched tile by tile.

import { logger } from "../lib/logger";
import pLimit from "../lib/limit";
import type { PlaceItem } from "./contract";
import { boxSpanKm, tiles, type Box } from "./area";
import { cached, cacheKey } from "./geo-cache";
import { geocodeOsm } from "./osm";

const API_KEY = () => {
    const key = process.env.GOOGLE_MAP_API_KEY;
    if (!key) throw new Error("GOOGLE_MAP_API_KEY is not set on the task server");
    return key;
};

/** Google returns at most 60 results (3 pages of 20) per text search. */
const MAX_PER_SEARCH = 60;

// ─── Geocoding ───────────────────────────────────────────────────────────────

type GeocodeResponse = {
    status: string;
    results?: {
        formatted_address?: string;
        geometry?: {
            location?: { lat: number; lng: number };
            bounds?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
            viewport?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
        };
    }[];
};

export type Geocoded = { name: string; lat: number; lng: number; box: Box };

/**
 * Where a place name is: its point and its extent (a city's bounds, a venue's
 * viewport). Google first; OpenStreetMap when Google can't place it (or its key
 * isn't allowed to geocode).
 */
export function geocode(address: string): Promise<Geocoded | null> {
    const text = address.trim();
    if (!text) return Promise.resolve(null);
    return cached(cacheKey("v3", "geocode", text), async () => (await geocodeGoogle(text)) ?? geocodeOsm(text));
}

async function geocodeGoogle(text: string): Promise<Geocoded | null> {
    const key = process.env.GOOGLE_MAP_API_KEY;
    if (!key) return null;
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", text);
    url.searchParams.set("key", key);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res) return null;
    const data = (await res.json()) as GeocodeResponse & { error_message?: string };
    const hit = data.results?.[0];
    const loc = hit?.geometry?.location;
    if (data.status !== "OK" || !loc) {
        logger.warn(`[google] geocode "${text}" → ${data.status}${data.error_message ? ` (${data.error_message})` : ""}`);
        return null;
    }
    const b = hit.geometry?.bounds ?? hit.geometry?.viewport;
    const box: Box = b
        ? { south: b.southwest.lat, west: b.southwest.lng, north: b.northeast.lat, east: b.northeast.lng }
        : { south: loc.lat - 0.05, north: loc.lat + 0.05, west: loc.lng - 0.05, east: loc.lng + 0.05 };
    return { name: hit.formatted_address ?? text, lat: loc.lat, lng: loc.lng, box };
}

// ─── Places text search ──────────────────────────────────────────────────────

type NewPlace = {
    id?: string;
    displayName?: { text: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
};

type CachedPlace = { id: string; title: string; address?: string; lat: number; lng: number };

/** One text search restricted to `box` (up to 60 results), cached per query + box. */
async function searchBox(query: string, box: Box): Promise<CachedPlace[]> {
    const boxKey = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(3)).join(",");
    const places = await cached(cacheKey("v2", "places", query, boxKey), async () => {
        const found: CachedPlace[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_PER_SEARCH / 20; page++) {
            const body: Record<string, unknown> = { textQuery: query, pageSize: 20, languageCode: "en" };
            if (pageToken) body.pageToken = pageToken;
            else body.locationRestriction = { rectangle: { low: { latitude: box.south, longitude: box.west }, high: { latitude: box.north, longitude: box.east } } };

            const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": API_KEY(),
                    "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,nextPageToken",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(12_000),
            });
            const data = (await res.json()) as { places?: NewPlace[]; nextPageToken?: string; error?: { message?: string } };
            if (!res.ok) {
                logger.warn(`[google] places "${query}" → ${res.status} ${data.error?.message ?? ""}`);
                if (page === 0) return null; // don't cache a failure
                break;
            }
            for (const p of data.places ?? []) {
                if (p.id && p.location) {
                    found.push({ id: p.id, title: p.displayName?.text ?? "Unnamed place", address: p.formattedAddress, lat: p.location.latitude, lng: p.location.longitude });
                }
            }
            pageToken = data.nextPageToken;
            if (!pageToken) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        return found;
    });
    return places ?? [];
}

/**
 * Places matching `query` inside `box`. Asking for more than one search can
 * return (60), or searching a large box, splits the box into tiles so the
 * results cover the whole area instead of clustering in the middle.
 */
export async function searchPlaces(query: string, box: Box, limit: number): Promise<PlaceItem[]> {
    const span = boxSpanKm(box);
    const grid = limit > MAX_PER_SEARCH || span > 60 ? (limit > 120 || span > 150 ? 3 : 2) : 1;
    const run = pLimit(4);
    const batches = await Promise.all(tiles(box, grid).map((t) => run(() => searchBox(query, t))));

    const seen = new Set<string>();
    const out: PlaceItem[] = [];
    for (const p of batches.flat()) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        out.push({ key: p.id, gPlaceId: p.id, title: p.title, address: p.address, lat: p.lat, lng: p.lng, kind: "place" });
    }
    return out.slice(0, limit);
}

/** Best match for a named place (e.g. a landmark from a web list) near `near`. */
export async function findPlace(name: string, near: string): Promise<CachedPlace | null> {
    const text = near ? `${name}, ${near}` : name;
    return cached(cacheKey("v2", "place", text), async () => {
        const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": API_KEY(),
                "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
            },
            body: JSON.stringify({ textQuery: text, pageSize: 1, languageCode: "en" }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const p = ((await res.json()) as { places?: NewPlace[] }).places?.[0];
        if (!p?.id || !p.location) return null;
        return { id: p.id, title: p.displayName?.text ?? name, address: p.formattedAddress, lat: p.location.latitude, lng: p.location.longitude };
    });
}
