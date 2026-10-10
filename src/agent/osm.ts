// src/agent/osm.ts
//
// OpenStreetMap's Nominatim, used when Google can't place a name. Its usage
// policy allows about one request a second with an identifying User-Agent, so
// requests are queued one at a time (answers are cached by the caller).

import { logger } from "../lib/logger";
import type { Box } from "./area";

const GAP_MS = 1100;
let last = Promise.resolve();

type Hit = { lat: string; lon: string; display_name: string; boundingbox?: string[] };

/** Where a place name is, with its extent, or null. */
export async function geocodeOsm(text: string): Promise<{ name: string; lat: number; lng: number; box: Box } | null> {
    const turn = last.then(() => new Promise<void>((r) => setTimeout(r, GAP_MS)));
    last = turn;
    await turn;
    try {
        const q = new URLSearchParams({ q: text, format: "jsonv2", limit: "1" });
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${q.toString()}`, {
            headers: { "User-Agent": "Wadzzo task server (map assistant)", "Accept-Language": "en" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const [hit] = (await res.json()) as Hit[];
        if (!hit) return null;
        const lat = Number(hit.lat);
        const lng = Number(hit.lon);
        const [s, n, w, e] = (hit.boundingbox ?? []).map(Number);
        const box: Box =
            s !== undefined && n !== undefined && w !== undefined && e !== undefined && [s, n, w, e].every(Number.isFinite)
                ? { south: s, north: n, west: w, east: e }
                : { south: lat - 0.05, north: lat + 0.05, west: lng - 0.05, east: lng + 0.05 };
        return { name: hit.display_name, lat, lng, box };
    } catch (err) {
        logger.warn(`[osm] geocode "${text}" failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
