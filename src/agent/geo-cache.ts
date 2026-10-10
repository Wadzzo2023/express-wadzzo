// src/agent/geo-cache.ts
//
// Database-backed cache (GeoCache table) for Google lookups, so repeating a
// search costs no API calls. Places and geocodes are public data, never
// anything brand-specific.

import { db } from "../lib/db";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

type Entry<T> = { value: T; cachedAt: number };

export function cacheKey(...parts: (string | number)[]): string {
    return parts.map((p) => String(p).toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_.,:-]/g, "")).join(":");
}

/** Cached value for `key`, loading (and storing) it when missing or older than `ttlMs`. */
export async function cached<T>(key: string, load: () => Promise<T | null>, ttlMs = MONTH_MS): Promise<T | null> {
    try {
        const row = await db.geoCache.findUnique({ where: { key } });
        if (row) {
            const entry = JSON.parse(row.value) as Entry<T>;
            if (entry && typeof entry.cachedAt === "number" && Date.now() - entry.cachedAt < ttlMs) return entry.value;
        }
    } catch {
        // unreadable or legacy entry — reload below
    }

    const value = await load();
    if (value !== null) {
        const json = JSON.stringify({ value, cachedAt: Date.now() } satisfies Entry<T>);
        await db.geoCache
            .upsert({ where: { key }, create: { key, value: json }, update: { value: json } })
            .catch((err: unknown) => console.warn("[geo-cache] write failed:", err));
    }
    return value;
}
