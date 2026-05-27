import { db } from "../lib/db";

function normalize(s: string): string {
    return s.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function cacheGet<T>(key: string): Promise<T | null> {
    try {
        const row = await db.geoCache.findUnique({ where: { key } });
        if (!row) return null;
        return JSON.parse(row.value) as T;
    } catch {
        return null;
    }
}

async function cacheSet(key: string, value: unknown): Promise<void> {
    try {
        const json = JSON.stringify(value);
        await db.geoCache.upsert({
            where: { key },
            create: { key, value: json },
            update: { value: json },
        });
    } catch (err) {
        console.warn("[GeoCache] Write failed:", err);
    }
}

// ── Geocode ──────────────────────────────────────────────────────────────────

export interface CachedGeocode {
    lat: number;
    lng: number;
    gPlaceId?: string;
}

export async function getCachedGeocode(name: string, area: string): Promise<CachedGeocode | null> {
    return cacheGet<CachedGeocode>(`geo:${normalize(name)}:${normalize(area || "global")}`);
}

export async function setCachedGeocode(name: string, area: string, result: CachedGeocode): Promise<void> {
    await cacheSet(`geo:${normalize(name)}:${normalize(area || "global")}`, result);
}

// ── Bounds ───────────────────────────────────────────────────────────────────

export interface CachedBounds {
    lat: number;
    lng: number;
    latDelta: number;
    lngDelta: number;
}

export async function getCachedBounds(area: string): Promise<CachedBounds | null> {
    return cacheGet<CachedBounds>(`bounds:${normalize(area)}`);
}

export async function setCachedBounds(area: string, result: CachedBounds): Promise<void> {
    await cacheSet(`bounds:${normalize(area)}`, result);
}

// ── Places ───────────────────────────────────────────────────────────────────

const PLACES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 1 month

interface CachedPlacesEntry<T> {
    pins: T[];
    nextPageToken?: string; // Google cursor — resume from here on top-up
    cachedAt: number;       // set once on first fetch, never updated on top-ups
    isComplete: boolean;    // true = Google has no more results for this query
}

export interface CachedPlacesResult<T> {
    pins: T[];
    shortfall: number;          // how many more to fetch from Google
    cachedIds: Set<string>;     // pre-seeded IDs — used to skip duplicates
    resumePageToken?: string;   // pass to Google to continue with zero overlap
}

function isStale<T>(entry: CachedPlacesEntry<T>): boolean {
    return Date.now() - entry.cachedAt > PLACES_TTL_MS;
}

/**
 * Upsert-maximum strategy with 1-month TTL:
 *
 *  DB empty / missing        → shortfall = count, fetch from page 1
 *  DB stale  (> 1 month)     → shortfall = count, fetch from page 1 (catches new locations)
 *  DB has >= count (fresh)   → return random `count` from DB, 0 API calls
 *  DB has <  count (fresh)   → return all DB pins + resume pageToken for exact shortfall
 */
export async function getCachedPlaces<T>(
    query: string,
    area: string,
    count: number
): Promise<CachedPlacesResult<T>> {
    const cached = await cacheGet<CachedPlacesEntry<T>>(
        `places:${normalize(query)}:${normalize(area)}`
    );

    // No cache or stale → full fresh fetch from page 1
    if (!cached || cached.pins.length === 0 || isStale(cached)) {
        if (cached && isStale(cached)) {
            console.info(
                `[getCachedPlaces] Cache expired (>1 month) for "${query}" in "${area}" — ` +
                `cachedAt=${new Date(cached.cachedAt).toISOString()}, count=${cached.pins.length}. Refreshing.`
            );
        }
        return {
            pins: [],
            shortfall: count,
            cachedIds: new Set(),
            resumePageToken: undefined,
        };
    }

    const cachedIds = new Set(cached.pins.map((p) => (p as { id: string }).id));

    // Have enough → random sample, zero API calls
    if (cached.pins.length >= count) {
        return {
            pins: shuffleArray(cached.pins).slice(0, count),
            shortfall: 0,
            cachedIds,
            resumePageToken: undefined,
        };
    }

    // Have some but not enough → resume from saved pageToken (zero overlap)
    return {
        pins: cached.pins,
        shortfall: count - cached.pins.length,
        cachedIds,
        resumePageToken: cached.nextPageToken,
    };
}

/**
 * Merges fresh pins into the cache.
 *
 * - `cachedAt` is set ONLY on the very first write — never updated on top-ups.
 *   This means the 1-month clock starts from the initial fetch, not each top-up.
 * - If existing cache is stale, it is wiped and replaced with the fresh data.
 * - `nextPageToken` is updated to reflect where Google stopped this time.
 * - `isComplete` is true when Google returned no nextPageToken (no more results).
 */
export async function setCachedPlaces<T>(
    query: string,
    area: string,
    pins: T[],
    nextPageToken?: string,
    isComplete = false,
): Promise<void> {
    const key = `places:${normalize(query)}:${normalize(area)}`;
    const existing = await cacheGet<CachedPlacesEntry<T>>(key);

    // If stale, start fresh — don't merge into expired data
    const existingPins = (existing && !isStale(existing)) ? existing.pins : [];
    const isFirstWrite = existingPins.length === 0;

    const seenIds = new Set(existingPins.map((p) => (p as { id: string }).id));
    const merged = [
        ...existingPins,
        ...pins.filter((p) => !seenIds.has((p as { id: string }).id)),
    ];

    await cacheSet(key, {
        pins: merged,
        nextPageToken,
        // Preserve original cachedAt on top-ups so the 1-month TTL
        // runs from the very first fetch, not from the latest top-up
        cachedAt: isFirstWrite ? Date.now() : (existing?.cachedAt ?? Date.now()),
        isComplete: isComplete || !nextPageToken,
    } satisfies CachedPlacesEntry<T>);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffleArray<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}