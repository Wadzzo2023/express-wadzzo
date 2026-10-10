// src/agent/tools/propose.ts
//
// Proposals: the ONLY way the agent can change anything. Each tool checks what
// it can (the items are the brand's own, dates make sense) and adds a
// confirmation card. Nothing is written to the brand's data here — the brand
// app does that when the person confirms, after checking everything again.

import { z } from "zod";
import { db } from "../../lib/db";
import {
    UNLIMITED_COLLECTIONS,
    type AnnouncementDraft,
    type EventDraft,
    type HotspotChanges,
    type NamedRef,
    type PinChanges,
    type PinDefaults,
    type PinTypeName,
} from "../contract";
import { geocode } from "../google";
import type { Run } from "../run";
import { defineTool, isoDay, parseDate, plural } from "./define";
import { findHotspots, ownPins, PIN_TYPES } from "./scope";

const MAX_PINS_PER_PROPOSAL = 200;
const DAY = 86_400_000;

const httpUrl = z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "Only http(s) links");

function addDays(d: Date, days: number) {
    return new Date(d.getTime() + days * DAY);
}

function checkRange(start: Date, end: Date, what: string) {
    if (end <= start) throw new Error(`${what} must end after it starts.`);
}

/** Pins named either by ids or by a find_pins ref, limited to the brand's own. */
async function pinsFrom(run: Run, a: { pinIds?: string[]; ref?: string }): Promise<NamedRef[]> {
    const ids = a.ref ? run.result(a.ref, "pins").items.map((p) => p.id) : (a.pinIds ?? []);
    if (ids.length === 0) throw new Error("Name the pins: pass pinIds or a ref from find_pins.");
    const own = await ownPins(run.brand.creatorId, ids);
    if (own.length === 0) throw new Error("None of those are this brand's pins. Use find_pins to get the right ids.");
    return own;
}

async function ownHotspot(run: Run, hotspotId: string): Promise<NamedRef> {
    const [h] = await findHotspots(run.brand.creatorId, { ids: [hotspotId], limit: 1 });
    if (!h) throw new Error("That isn't one of this brand's hotspots. Use find_hotspots to get its id.");
    return { id: h.id, title: h.title };
}

async function ownRow(table: "event" | "announcement", run: Run, id: string): Promise<NamedRef> {
    const where = { id, creatorId: run.brand.creatorId };
    const row =
        table === "event"
            ? await db.creatorEvent.findFirst({ where, select: { id: true, title: true } })
            : await db.creatorAnnouncement.findFirst({ where, select: { id: true, title: true } });
    if (!row) throw new Error(`That isn't one of this brand's ${table}s. Use find_${table}s to get its id.`);
    return row;
}

const done = (run: Run, summary: string) => ({
    model: { proposed: true, summary, note: "The person sees a confirmation card and decides. Tell them briefly what you prepared; don't claim it's done." },
    detail: "Ready for your review",
});

export const proposeTools = [
    // ── Pins ─────────────────────────────────────────────────────────────────
    defineTool({
        name: "propose_pins",
        description:
            "Prepare NEW pins from a places ref (search_places / search_web_list / search_events) for the person to review and confirm. " +
            "Coordinates always come from the search, never from you. Places already pinned are skipped unless listed in `keys` or includeAlreadyPinned. " +
            "Settings you leave out use the brand's usual settings; the person can change everything on the card.",
        schema: z.object({
            ref: z.string(),
            keys: z.array(z.string()).max(MAX_PINS_PER_PROPOSAL).optional().describe("Only these places (keys from the ref); omit for all"),
            includeAlreadyPinned: z.boolean().default(false),
            type: z.enum(PIN_TYPES).optional(),
            startDate: z.string().optional().describe("YYYY-MM-DD; default today"),
            endDate: z.string().optional().describe("YYYY-MM-DD; or use durationDays"),
            durationDays: z.number().int().min(1).max(36500).optional(),
            autoCollect: z.boolean().optional().describe("Collected automatically when a fan walks into range"),
            pinNumber: z.number().int().min(1).max(200).optional().describe("Collectible copies at each place"),
            radiusMetres: z.number().min(0).max(5000).optional(),
            collectionLimit: z.number().int().min(1).max(UNLIMITED_COLLECTIONS).optional(),
            grouping: z.enum(["per-location", "single-group"]).optional().describe("One pin per place (default) or all places in one pin"),
        }),
        label: (a, run) => {
            const set = run.results.get(a.ref);
            const n = set && "items" in set ? (a.keys?.length ?? set.items.length) : 0;
            return `Preparing ${n ? plural(n, "pin") : "pins"} for your review…`;
        },
        run: async (a, run) => {
            const set = run.result(a.ref, "places");
            const keyed = a.keys?.length ? set.items.filter((i) => a.keys!.includes(i.key)) : set.items;
            const items = keyed.filter((i) => a.includeAlreadyPinned || a.keys?.length || !i.alreadyPinned).slice(0, MAX_PINS_PER_PROPOSAL);
            if (items.length === 0) throw new Error("No places left to pin (they may all be pinned already). Tell the person, or use includeAlreadyPinned.");

            const habits = run.brand.habits;
            const allEvents = items.every((i) => i.kind === "event");
            const start = a.startDate ? parseDate(a.startDate, "startDate") : new Date();
            const end = a.endDate ? parseDate(a.endDate, "endDate") : addDays(start, a.durationDays ?? habits?.durationDays ?? 30);
            checkRange(start, end, "The pins");

            const defaults: PinDefaults = {
                type: (a.type ?? (allEvents ? "EVENT" : (habits?.type ?? "LANDMARK"))) as PinTypeName,
                startDate: isoDay(start),
                endDate: isoDay(end),
                autoCollect: a.autoCollect ?? habits?.autoCollect ?? false,
                pinNumber: a.pinNumber ?? 1,
                radius: a.radiusMetres ?? 2,
                collectionLimit: a.collectionLimit ?? UNLIMITED_COLLECTIONS,
                grouping: a.grouping ?? "per-location",
            };
            const skipped = keyed.length - items.length;
            const summary = `Create ${plural(items.length, "pin")} from “${set.title}”${skipped ? ` (skipping ${skipped} already pinned)` : ""}`;
            run.propose({ type: "create_pins", items, defaults }, summary);
            return done(run, summary);
        },
    }),

    defineTool({
        name: "propose_pin_changes",
        description: "Prepare edits to, or deletion of, the brand's existing pins (by ids or a find_pins ref) for the person to confirm.",
        schema: z.object({
            mode: z.enum(["update", "delete"]),
            pinIds: z.array(z.string()).max(MAX_PINS_PER_PROPOSAL).optional(),
            ref: z.string().optional(),
            changes: z
                .object({
                    title: z.string().min(3).max(120).optional(),
                    description: z.string().max(5000).optional(),
                    startDate: z.string().optional(),
                    endDate: z.string().optional(),
                    link: httpUrl.optional(),
                    image: httpUrl.optional(),
                    collectionLimit: z.number().int().min(1).max(UNLIMITED_COLLECTIONS).optional(),
                    autoCollect: z.boolean().optional(),
                })
                .optional(),
        }),
        label: (a) => (a.mode === "delete" ? "Preparing the deletion for your review…" : "Preparing the changes for your review…"),
        run: async (a, run) => {
            const pins = await pinsFrom(run, a);
            if (a.mode === "delete") {
                const summary = `Delete ${plural(pins.length, "pin")}`;
                run.propose({ type: "hide_pins", pins }, summary);
                return done(run, summary);
            }
            const c = a.changes ?? {};
            const changes: PinChanges = { ...c };
            if (c.startDate) changes.startDate = isoDay(parseDate(c.startDate, "startDate"));
            if (c.endDate) changes.endDate = isoDay(parseDate(c.endDate, "endDate"));
            if (changes.startDate && changes.endDate) checkRange(new Date(changes.startDate), new Date(changes.endDate), "The pins");
            if (Object.keys(changes).length === 0) throw new Error("No changes given.");
            const what = Object.keys(changes).join(", ");
            const summary = `Change ${what} on ${plural(pins.length, "pin")}`;
            run.propose({ type: "update_pins", pins, changes }, summary);
            return done(run, summary);
        },
    }),

    // ── Hotspots ─────────────────────────────────────────────────────────────
    defineTool({
        name: "propose_hotspot",
        description:
            "Prepare a hotspot change for the person to confirm: create a new circular hotspot (an area that drops pins on a schedule), " +
            "change one's schedule, or pause / resume / delete one (hotspotId from find_hotspots).",
        schema: z.object({
            mode: z.enum(["create", "update", "pause", "resume", "delete"]),
            hotspotId: z.string().optional(),
            // create
            title: z.string().min(3).max(120).optional(),
            description: z.string().max(2000).optional(),
            place: z.string().optional().describe("create: where the centre is (address / landmark)"),
            lat: z.number().min(-90).max(90).optional(),
            lng: z.number().min(-180).max(180).optional(),
            radiusMetres: z.number().min(50).max(50_000).optional(),
            type: z.enum(PIN_TYPES).optional(),
            pinNumber: z.number().int().min(1).max(100).optional().describe("Pins per drop"),
            collectionLimit: z.number().int().min(1).max(UNLIMITED_COLLECTIONS).optional(),
            // create + update
            startDate: z.string().optional(),
            endDate: z.string().optional(),
            dropEveryDays: z.number().int().min(1).max(365).optional(),
            pinDurationDays: z.number().int().min(1).max(365).optional(),
            autoCollect: z.boolean().optional(),
        }),
        label: (a) => (a.mode === "create" ? `Preparing a hotspot${a.place ? ` at ${a.place}` : ""}…` : "Preparing the hotspot change for your review…"),
        run: async (a, run) => {
            if (a.mode !== "create") {
                if (!a.hotspotId) throw new Error("hotspotId is required. Use find_hotspots.");
                const hotspot = await ownHotspot(run, a.hotspotId);
                if (a.mode === "update") {
                    const changes: HotspotChanges = {};
                    if (a.startDate) changes.startDate = isoDay(parseDate(a.startDate, "startDate"));
                    if (a.endDate) changes.endDate = isoDay(parseDate(a.endDate, "endDate"));
                    if (a.dropEveryDays) changes.dropEveryDays = a.dropEveryDays;
                    if (a.pinDurationDays) changes.pinDurationDays = a.pinDurationDays;
                    if (a.autoCollect !== undefined) changes.autoCollect = a.autoCollect;
                    if (Object.keys(changes).length === 0) throw new Error("No changes given.");
                    const summary = `Change ${Object.keys(changes).join(", ")} on hotspot “${hotspot.title}”`;
                    run.propose({ type: "update_hotspot", hotspot, changes }, summary);
                    return done(run, summary);
                }
                const verb = { pause: "Pause", resume: "Resume", delete: "Delete" }[a.mode];
                const summary = `${verb} hotspot “${hotspot.title}”`;
                run.propose({ type: "hotspot_state", hotspot, op: a.mode }, summary);
                return done(run, summary);
            }

            if (!a.title) throw new Error("A new hotspot needs a title (what its pins are called).");
            let lat = a.lat;
            let lng = a.lng;
            if ((lat === undefined || lng === undefined) && a.place) {
                const hit = await geocode(a.place);
                if (!hit) throw new Error(`Couldn't find "${a.place}" on the map.`);
                ({ lat, lng } = hit);
            }
            if (lat === undefined || lng === undefined) throw new Error("Say where the hotspot is: `place`, or lat/lng from a search.");
            const start = a.startDate ? parseDate(a.startDate, "startDate") : new Date();
            const end = a.endDate ? parseDate(a.endDate, "endDate") : addDays(start, 90);
            checkRange(start, end, "The hotspot");
            const hotspot = {
                title: a.title,
                description: a.description,
                lat,
                lng,
                radiusMetres: a.radiusMetres ?? 500,
                type: (a.type ?? run.brand.habits?.type ?? "LANDMARK") as PinTypeName,
                startDate: isoDay(start),
                endDate: isoDay(end),
                dropEveryDays: a.dropEveryDays ?? 7,
                pinDurationDays: a.pinDurationDays ?? 7,
                pinNumber: a.pinNumber ?? 1,
                collectionLimit: a.collectionLimit ?? UNLIMITED_COLLECTIONS,
                autoCollect: a.autoCollect ?? run.brand.habits?.autoCollect ?? false,
            };
            const summary = `Create hotspot “${a.title}” (${hotspot.radiusMetres} m), dropping every ${plural(hotspot.dropEveryDays, "day")}`;
            run.propose({ type: "create_hotspot", hotspot }, summary);
            return done(run, summary);
        },
    }),

    // ── Events ───────────────────────────────────────────────────────────────
    defineTool({
        name: "propose_event",
        description: "Prepare a new event listing, an edit to one, or its deletion (eventId from find_events) for the person to confirm.",
        schema: z.object({
            mode: z.enum(["create", "update", "delete"]),
            eventId: z.string().optional(),
            title: z.string().min(3).max(120).optional(),
            description: z.string().min(1).max(5000).optional(),
            startDate: z.string().optional().describe("ISO date-time, e.g. 2026-11-01T18:00"),
            endDate: z.string().optional(),
            venueName: z.string().max(120).optional(),
            address: z.string().max(300).optional().describe("Venue address; it is placed on the map"),
            link: httpUrl.optional(),
            capacity: z.number().int().min(1).max(1_000_000).optional(),
        }),
        label: (a) => (a.mode === "create" ? `Drafting the event${a.title ? ` “${a.title}”` : ""}…` : "Preparing the event change for your review…"),
        run: async (a, run) => {
            if (a.mode !== "create") {
                if (!a.eventId) throw new Error("eventId is required. Use find_events.");
                const event = await ownRow("event", run, a.eventId);
                if (a.mode === "delete") {
                    const summary = `Delete event “${event.title}”`;
                    run.propose({ type: "delete_event", event }, summary);
                    return done(run, summary);
                }
                const changes: Partial<EventDraft> = {};
                for (const k of ["title", "description", "venueName", "address", "link", "capacity"] as const) if (a[k] !== undefined) Object.assign(changes, { [k]: a[k] });
                if (a.startDate) changes.startDate = parseDate(a.startDate, "startDate").toISOString();
                if (a.endDate) changes.endDate = parseDate(a.endDate, "endDate").toISOString();
                if (a.address) Object.assign(changes, await placeOf(a.address));
                if (Object.keys(changes).length === 0) throw new Error("No changes given.");
                const summary = `Change ${Object.keys(changes).filter((k) => k !== "lat" && k !== "lng").join(", ")} on event “${event.title}”`;
                run.propose({ type: "update_event", event, changes }, summary);
                return done(run, summary);
            }

            if (!a.title || !a.description || !a.startDate || !a.endDate) throw new Error("A new event needs title, description, startDate and endDate. Ask for what's missing.");
            const start = parseDate(a.startDate, "startDate");
            const end = parseDate(a.endDate, "endDate");
            checkRange(start, end, "The event");
            const event: EventDraft = {
                title: a.title,
                description: a.description,
                startDate: start.toISOString(),
                endDate: end.toISOString(),
                venueName: a.venueName ?? null,
                address: a.address ?? null,
                link: a.link ?? null,
                capacity: a.capacity ?? null,
                ...(a.address ? await placeOf(a.address) : {}),
            };
            const summary = `Create event “${a.title}” on ${start.toDateString()}`;
            run.propose({ type: "create_event", event }, summary);
            return done(run, summary);
        },
    }),

    // ── Announcements ────────────────────────────────────────────────────────
    defineTool({
        name: "propose_announcement",
        description: "Prepare a new announcement (a post to the brand's fans), an edit, or a deletion (announcementId from find_announcements) for the person to confirm.",
        schema: z.object({
            mode: z.enum(["create", "update", "delete"]),
            announcementId: z.string().optional(),
            title: z.string().min(3).max(120).optional(),
            body: z.string().min(1).max(5000).optional(),
            pinned: z.boolean().optional(),
            ctaLabel: z.string().max(40).optional().describe("Button text, needs ctaUrl"),
            ctaUrl: httpUrl.optional(),
            expiresAt: z.string().optional().describe("ISO date-time after which it's hidden"),
        }),
        label: (a) => (a.mode === "create" ? "Drafting the announcement…" : "Preparing the announcement change for your review…"),
        run: async (a, run) => {
            if (a.ctaLabel && !a.ctaUrl) throw new Error("A button label needs ctaUrl (the link it opens).");
            const expiresAt = a.expiresAt ? parseDate(a.expiresAt, "expiresAt").toISOString() : undefined;
            if (a.mode !== "create") {
                if (!a.announcementId) throw new Error("announcementId is required. Use find_announcements.");
                const announcement = await ownRow("announcement", run, a.announcementId);
                if (a.mode === "delete") {
                    const summary = `Delete announcement “${announcement.title}”`;
                    run.propose({ type: "delete_announcement", announcement }, summary);
                    return done(run, summary);
                }
                const changes: Partial<AnnouncementDraft> = {};
                for (const k of ["title", "body", "pinned", "ctaLabel", "ctaUrl"] as const) if (a[k] !== undefined) Object.assign(changes, { [k]: a[k] });
                if (expiresAt) changes.expiresAt = expiresAt;
                if (Object.keys(changes).length === 0) throw new Error("No changes given.");
                const summary = `Change ${Object.keys(changes).join(", ")} on announcement “${announcement.title}”`;
                run.propose({ type: "update_announcement", announcement, changes }, summary);
                return done(run, summary);
            }

            if (!a.title || !a.body) throw new Error("A new announcement needs a title and body.");
            const announcement: AnnouncementDraft = {
                title: a.title,
                body: a.body,
                pinned: a.pinned ?? false,
                ctaLabel: a.ctaLabel ?? null,
                ctaUrl: a.ctaUrl ?? null,
                expiresAt: expiresAt ?? null,
            };
            const summary = `Post announcement “${a.title}”`;
            run.propose({ type: "create_announcement", announcement }, summary);
            return done(run, summary);
        },
    }),
];

async function placeOf(address: string): Promise<{ lat: number; lng: number } | Record<string, never>> {
    const hit = await geocode(address);
    return hit ? { lat: hit.lat, lng: hit.lng } : {};
}
