// src/agent/web.ts
//
// Web lookups for what Google Places can't list well: published lists (art
// trails, historic sites, "every Dambo troll") and upcoming events. The model
// reads the web; every location it names is then placed with Google, so
// coordinates always come from Google, never from the model.
//
// Everything read here is untrusted text: it is only ever turned into
// PlaceItems (name, address, dates, link), never into instructions.

import { ChatOpenAI } from "@langchain/openai";
import pLimit from "../lib/limit";
import { logger } from "../lib/logger";
import type { PlaceItem } from "./contract";
import { findPlace, geocode } from "./google";
import { AGENT_MODEL } from "./model";

type WebLocation = { name?: string; address?: string; city?: string; country?: string };
type WebEvent = { title?: string; description?: string; startDate?: string; endDate?: string; venueName?: string; address?: string; city?: string; url?: string };

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((b) => (typeof b === "string" ? b : typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "")).join("");
    }
    return "";
}

/** The first JSON array/object in a model reply (tolerates code fences and prose). */
export function parseJsonLoose<T>(raw: string): T | null {
    const clean = raw.replace(/```(?:json)?/gi, "").trim();
    const start = clean.search(/[[{]/);
    if (start < 0) return null;
    const open = clean[start]!;
    const close = open === "[" ? "]" : "}";
    const end = clean.lastIndexOf(close);
    if (end <= start) return null;
    try {
        return JSON.parse(clean.slice(start, end + 1)) as T;
    } catch {
        return null;
    }
}

async function askWeb(prompt: string): Promise<string> {
    const llm = new ChatOpenAI({ model: AGENT_MODEL, maxTokens: 8000 }).bindTools([{ type: "web_search_preview" } as never]);
    const res = await llm.invoke([{ role: "user", content: prompt }]);
    return textOf(res.content);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A worldwide list is looked up region by region: one web search asked for a
 * whole world list stops early (7 of 100+ trolls); per region it reads each
 * region's list in full.
 */
const WORLD_REGIONS = ["the United States", "Canada and Mexico", "Europe", "Asia", "Australia and New Zealand", "South America, Africa and the Middle East"];

/** Named locations of `query` in one region, read from the web. */
async function listFromWeb(query: string, where: string, limit: number): Promise<WebLocation[]> {
    const raw = await askWeb(
        `Search the web for the COMPLETE list of: ${query}${where ? ` in ${where}` : ""}.\n` +
            `Prefer the official source (the artist's, organiser's or brand's own map or list page), then Wikipedia or trail maps; ` +
            `open the list pages and read them in full rather than stopping at a few examples.\n` +
            `Return ONLY JSON: [{"name":"...","address":"street address or park/site name if known","city":"...","country":"..."}]\n` +
            `Include every location you find, up to ${limit}. Only list locations you actually read on a page — never guess or fill in. ` +
            `Leave out anything removed or no longer standing. No commentary.`,
    ).catch((err: unknown) => {
        logger.warn(`[web] list "${query}" in "${where}" failed: ${err instanceof Error ? err.message : String(err)}`);
        return "";
    });
    const found = (parseJsonLoose<WebLocation[]>(raw) ?? []).filter((l) => l.name && (l.address || l.city));
    logger.info(`[web] list "${query}" in "${where}" → ${found.length} named locations`);
    return found;
}

/** Every physical location in a published list of `query` ("" = worldwide), placed with Google. */
export async function searchWebList(query: string, where: string, limit: number): Promise<PlaceItem[]> {
    const lists = await Promise.all((where ? [where] : WORLD_REGIONS).map((region) => listFromWeb(query, region, limit)));
    const seen = new Set<string>();
    const found = lists.flat().filter((l) => {
        const id = `${l.name}|${l.city ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });

    const run = pLimit(6);
    const placed = await Promise.all(
        found.slice(0, limit).map((l, i) =>
            run(async (): Promise<PlaceItem | null> => {
                const near = [l.address, l.city, l.country].filter(Boolean).join(", ");
                const hit = await findPlace(l.name!, near).catch(() => null);
                if (hit) return { key: hit.id, gPlaceId: hit.id, title: hit.title, address: hit.address, lat: hit.lat, lng: hit.lng, kind: "place" };
                const geo = await geocode(near || l.name!).catch(() => null);
                return geo ? { key: `web_${i}_${geo.lat.toFixed(5)}`, title: l.name!, address: near || geo.name, lat: geo.lat, lng: geo.lng, kind: "place" } : null;
            }),
        ),
    );
    // One place can be found under two names; keep it once.
    const unique = new Map<string, PlaceItem>();
    for (const p of placed) if (p && !unique.has(p.key)) unique.set(p.key, p);
    return [...unique.values()];
}

/** Upcoming events for `query` in `where`, each placed at its venue. */
export async function searchEvents(query: string, where: string, limit: number): Promise<PlaceItem[]> {
    const raw = await askWeb(
        `Find up to ${limit} upcoming events for "${query}" in ${where}, starting on or after ${today()}.\n` +
            `Return ONLY JSON: [{"title":"...","description":"one sentence","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD",` +
            `"venueName":"...","address":"full street address","city":"...","url":"official page"}]. No commentary.`,
    );
    const now = today();
    const events = (parseJsonLoose<WebEvent[]>(raw) ?? []).filter(
        (e) => e.title && e.startDate && e.endDate && e.endDate >= now && e.endDate >= e.startDate,
    );
    logger.info(`[web] events "${query}" in "${where}" → ${events.length}`);

    const run = pLimit(6);
    const placed = await Promise.all(
        events.slice(0, limit).map((e, i) =>
            run(async (): Promise<PlaceItem | null> => {
                const candidates = [e.address, e.venueName && e.city ? `${e.venueName}, ${e.city}` : undefined, e.city].filter((c): c is string => Boolean(c?.trim()));
                for (const c of candidates) {
                    const geo = await geocode(c).catch(() => null);
                    if (geo) {
                        return {
                            key: `event_${i}_${e.startDate}_${geo.lat.toFixed(5)}`,
                            kind: "event",
                            title: e.title!,
                            address: [e.venueName, e.address ?? e.city].filter(Boolean).join(", ") || geo.name,
                            lat: geo.lat,
                            lng: geo.lng,
                            startDate: e.startDate,
                            endDate: e.endDate,
                            url: e.url && /^https?:\/\//i.test(e.url) ? e.url : undefined,
                        };
                    }
                }
                return null;
            }),
        ),
    );
    return placed.filter((p): p is PlaceItem => p !== null);
}
