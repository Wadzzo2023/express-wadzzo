// src/agent/tools/search.ts — finding real places and events to pin.

import { z } from "zod";
import type { PlaceItem } from "../contract";
import { inArea, metresBetween, searchBoxes, type SearchArea } from "../area";
import { geocode, searchPlaces } from "../google";
import type { Run } from "../run";
import { searchEvents, searchWebList } from "../web";
import { defineTool, plural } from "./define";
import { pinsNear } from "./scope";

/** A place counts as already pinned when one of the brand's pins is this close. */
const ALREADY_PINNED_M = 75;

const HOME_WORDS = /^(home|my area|our area|home area|here|local|nearby)$/i;
const ANYWHERE_WORDS = /^(anywhere|everywhere|worldwide|global|world|all)$/i;

const whereField = z
    .string()
    .optional()
    .describe('Where to search: a town, county, region, country, address or landmark. "worldwide" only when the person asked for no area limit.');

/** The area the person named. There is no default area: without one, the model must ask. */
export async function resolveArea(_run: Run, where: string | undefined, opts: { allowWorldwide?: boolean } = {}): Promise<SearchArea | null> {
    const text = where?.trim();
    if (!text || HOME_WORDS.test(text)) {
        throw new Error("No area given. Ask the person where to search (a town, county, region or country).");
    }
    if (ANYWHERE_WORDS.test(text)) {
        if (opts.allowWorldwide) return null;
        throw new Error("Place searches need an area. Ask the person which town, county or region to search.");
    }
    const hit = await geocode(text);
    if (!hit) throw new Error(`Couldn't find "${text}" on the map. Ask the person to name the place differently.`);
    return { name: hit.name, box: hit.box };
}

const areaName = (_run: Run, where?: string) => (!where?.trim() || HOME_WORDS.test(where.trim()) ? "your area" : where.trim());

/** Marks places the brand already has a pin at. */
async function flagPinned(run: Run, items: PlaceItem[]): Promise<PlaceItem[]> {
    if (items.length === 0) return items;
    const lats = items.map((i) => i.lat);
    const lngs = items.map((i) => i.lng);
    const pad = 0.002;
    const pins = await pinsNear(run.brand.creatorId, {
        south: Math.min(...lats) - pad,
        north: Math.max(...lats) + pad,
        west: Math.min(...lngs) - pad,
        east: Math.max(...lngs) + pad,
    });
    return items.map((i) => ({ ...i, alreadyPinned: pins.some((p) => metresBetween(i.lat, i.lng, p.latitude, p.longitude) < ALREADY_PINNED_M) }));
}

/** What the model reads about a place result: counts plus one line per place. */
function placesForModel(ref: string, items: PlaceItem[], area: string) {
    const pinned = items.filter((i) => i.alreadyPinned).length;
    return {
        ref,
        area,
        found: items.length,
        alreadyPinned: pinned,
        places: items.slice(0, 80).map((i) => `${i.key} | ${i.title}${i.address ? ` | ${i.address}` : ""}${i.startDate ? ` | ${i.startDate}→${i.endDate}` : ""}${i.alreadyPinned ? " | ALREADY PINNED" : ""}`),
        next: "Call show_results with this ref so the person sees the places on a card and the map.",
    };
}

function foundDetail(items: PlaceItem[], what: string) {
    const pinned = items.filter((i) => i.alreadyPinned).length;
    return `Found ${plural(items.length, what)}${pinned ? ` (${pinned} already pinned)` : ""}`;
}

export const searchTools = [
    defineTool({
        name: "search_places",
        description:
            "Find real places of a kind (music venues, record stores, parks, coffee shops, a chain's branches…) with Google Maps, " +
            "inside the area the person named. Use for anything Google Maps lists. Returns a ref for show_results / propose_pins.",
        schema: z.object({
            query: z.string().describe('What to find, e.g. "public parks", "Casey\'s stores", "museums"'),
            where: whereField,
            limit: z.number().int().min(1).max(200).default(40).describe("Most places to return (bulk: up to 200)"),
        }),
        label: (a, run) => `Searching ${a.query} in ${areaName(run, a.where)}…`,
        run: async (a, run) => {
            const area = (await resolveArea(run, a.where))!;
            // Search the area's box, then keep what's really inside the area's outline.
            // (An outline in several parts is searched part by part.)
            const want = area.rings ? Math.min(200, a.limit * 2) : a.limit;
            const boxes = searchBoxes(area);
            const found = (await Promise.all(boxes.map((box) => searchPlaces(a.query, box, Math.ceil(want / boxes.length))))).flat();
            const raw = found.filter((p, i) => found.findIndex((q) => q.key === p.key) === i);
            const items = await flagPinned(run, raw.filter((p) => inArea(area, p.lat, p.lng)).slice(0, a.limit));
            const ref = run.addResult({ kind: "places", title: `${a.query} in ${area.name}`, items, area: area.name });
            return { model: placesForModel(ref, items, area.name), detail: foundDetail(items, "place") };
        },
    }),

    defineTool({
        name: "search_web_list",
        description:
            "Find locations from published lists on the web — an artist's works (e.g. Thomas Dambo trolls), art trails, historic markers, " +
            "festival venues, a series or collection — anything Google Maps won't list as one category. Use this, not search_places, " +
            "for a named collection. Worldwide lists are read region by region. Slower than search_places. Returns a ref.",
        schema: z.object({
            query: z.string().describe('e.g. "Thomas Dambo troll sculptures", "historic barn quilts"'),
            where: whereField,
            limit: z.number().int().min(1).max(200).default(100).describe("Most locations (for 'all …' use 200)"),
        }),
        label: (a, run) => `Looking up ${a.query} on the web${a.where && ANYWHERE_WORDS.test(a.where) ? "" : ` (${areaName(run, a.where)})`}…`,
        run: async (a, run) => {
            const area = await resolveArea(run, a.where, { allowWorldwide: true });
            const found = await searchWebList(a.query, area?.name ?? "", a.limit);
            const items = await flagPinned(run, area ? found.filter((p) => inArea(area, p.lat, p.lng)) : found);
            const ref = run.addResult({ kind: "places", title: area ? `${a.query} in ${area.name}` : a.query, items, area: area?.name });
            return { model: placesForModel(ref, items, area?.name ?? "worldwide"), detail: foundDetail(items, "location") };
        },
    }),

    defineTool({
        name: "search_events",
        description: "Find upcoming real-world events (concerts, fairs, markets, games…) with dates and venues. Returns a ref; items carry start/end dates.",
        schema: z.object({
            query: z.string().describe('e.g. "farmers markets", "live music", "county fair"'),
            where: whereField,
            limit: z.number().int().min(1).max(40).default(15),
        }),
        label: (a, run) => `Finding upcoming ${a.query} in ${areaName(run, a.where)}…`,
        run: async (a, run) => {
            const area = (await resolveArea(run, a.where))!;
            const found = await searchEvents(a.query, area.name, a.limit);
            // Venues just outside a polygon still matter for events; keep anything in the area's box.
            const items = await flagPinned(run, found.filter((p) => inArea({ name: area.name, box: area.box }, p.lat, p.lng)));
            const ref = run.addResult({ kind: "places", title: `Upcoming ${a.query} in ${area.name}`, items, area: area.name });
            return { model: placesForModel(ref, items, area.name), detail: foundDetail(items, "event") };
        },
    }),

    defineTool({
        name: "locate",
        description: "Find where one named place or address is (coordinates). Use before proposing a hotspot or event at a named venue.",
        schema: z.object({ place: z.string() }),
        label: (a) => `Locating ${a.place}…`,
        run: async (a) => {
            const hit = await geocode(a.place);
            if (!hit) return { model: { found: false }, detail: "Not found" };
            return { model: { found: true, name: hit.name, lat: hit.lat, lng: hit.lng }, detail: hit.name };
        },
    }),
];
