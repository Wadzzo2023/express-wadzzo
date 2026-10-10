// src/agent/tools/brand.ts — reading the brand's own pins, hotspots, events and announcements.

import { z } from "zod";
import { db } from "../../lib/db";
import type { PinStatus } from "../contract";
import { boxAround } from "../area";
import { geocode } from "../google";
import { defineTool, plural } from "./define";
import { findHotspots, findPins, PIN_TYPES } from "./scope";
import { resolveArea } from "./search";

const STATUSES = ["current", "active", "upcoming", "expired", "in_review", "rejected", "any"] as const;
const STATUS_WORD: Record<(typeof STATUSES)[number], string> = {
    current: "",
    active: "active ",
    upcoming: "upcoming ",
    expired: "expired ",
    in_review: "in-review ",
    rejected: "rejected ",
    any: "",
};

export const brandTools = [
    defineTool({
        name: "find_pins",
        description:
            "Search the brand's OWN pins (drops) by text, type, status, area and age. Use before editing, deleting or reporting on pins. " +
            "Returns a ref (for show_results, propose_pin_changes, pin_stats) and one line per pin: id | title | type | status | collections.",
        schema: z.object({
            text: z.string().optional().describe("Words in the title or description"),
            type: z.enum(PIN_TYPES).optional(),
            status: z.enum(STATUSES).default("current").describe('"current" = not expired (default); "any" includes expired'),
            where: z.string().optional().describe('Limit to an area: "home" for the home area, or a place name. Omit for anywhere.'),
            radiusKm: z.number().min(0.1).max(200).optional().describe("With `where` naming a point (address/landmark): pins within this distance"),
            createdInLastDays: z.number().int().min(1).max(3650).optional(),
            limit: z.number().int().min(1).max(200).default(50),
        }),
        label: (a) => `Looking through your ${STATUS_WORD[a.status]}pins${a.text ? ` for “${a.text}”` : ""}…`,
        run: async (a, run) => {
            let area = null;
            if (a.where) {
                if (a.radiusKm) {
                    const hit = await geocode(a.where);
                    if (!hit) throw new Error(`Couldn't find "${a.where}" on the map.`);
                    area = { name: `${a.radiusKm} km around ${hit.name}`, box: boxAround(hit.lat, hit.lng, a.radiusKm) };
                } else {
                    area = await resolveArea(run, a.where);
                }
            }
            const { items, total } = await findPins(run.brand.creatorId, { ...a, status: a.status as PinStatus | "current" | "any", area });
            const ref = run.addResult({ kind: "pins", title: a.text ? `Your pins matching “${a.text}”` : `Your ${STATUS_WORD[a.status]}pins`, items });
            return {
                model: {
                    ref,
                    total,
                    returned: items.length,
                    pins: items.map((p) => `${p.id} | ${p.title} | ${p.type} | ${p.status} | ${p.collected} collections | ${p.startDate.slice(0, 10)}→${p.endDate.slice(0, 10)}`),
                },
                detail: total > items.length ? `Found ${plural(total, "pin")}, showing ${items.length}` : `Found ${plural(total, "pin")}`,
            };
        },
    }),

    defineTool({
        name: "find_hotspots",
        description: "List the brand's OWN hotspots (areas that drop pins on a schedule). Returns a ref and one line per hotspot: id | name | active/paused | schedule.",
        schema: z.object({
            text: z.string().optional().describe("Words in the hotspot's drop titles"),
            status: z.enum(["active", "paused", "any"]).default("any"),
            limit: z.number().int().min(1).max(100).default(30),
        }),
        label: () => "Checking your hotspots…",
        run: async (a, run) => {
            const items = await findHotspots(run.brand.creatorId, a);
            const ref = run.addResult({ kind: "hotspots", title: "Your hotspots", items });
            return {
                model: {
                    ref,
                    hotspots: items.map((h) => `${h.id} | ${h.title} | ${h.isActive ? "active" : "paused"} | drops every ${h.dropEveryDays}d, each lasts ${h.pinDurationDays}d | ${h.startDate.slice(0, 10)}→${h.endDate.slice(0, 10)} | ${h.drops} drops so far`),
                },
                detail: `Found ${plural(items.length, "hotspot")}`,
            };
        },
    }),

    defineTool({
        name: "find_events",
        description: "List the brand's OWN events (its event listings, not web events). Returns a ref and one line per event.",
        schema: z.object({
            when: z.enum(["upcoming", "past", "all"]).default("upcoming"),
            text: z.string().optional(),
            limit: z.number().int().min(1).max(100).default(30),
        }),
        label: (a) => `Checking your ${a.when === "all" ? "" : `${a.when} `}events…`,
        run: async (a, run) => {
            const now = new Date();
            const rows = await db.creatorEvent.findMany({
                where: {
                    creatorId: run.brand.creatorId,
                    ...(a.when === "upcoming" && { endDate: { gte: now } }),
                    ...(a.when === "past" && { endDate: { lt: now } }),
                    ...(a.text && { title: { contains: a.text, mode: "insensitive" } }),
                },
                orderBy: { startDate: a.when === "past" ? "desc" : "asc" },
                take: a.limit,
                select: { id: true, title: true, startDate: true, endDate: true, venueName: true, address: true, latitude: true, longitude: true, _count: { select: { rsvps: true } } },
            });
            const items = rows.map((e) => ({
                id: e.id,
                title: e.title,
                startDate: e.startDate.toISOString(),
                endDate: e.endDate.toISOString(),
                venueName: e.venueName,
                address: e.address,
                lat: e.latitude,
                lng: e.longitude,
                rsvps: e._count.rsvps,
            }));
            const ref = run.addResult({ kind: "events", title: `Your ${a.when === "all" ? "" : `${a.when} `}events`, items });
            return {
                model: { ref, events: items.map((e) => `${e.id} | ${e.title} | ${e.startDate.slice(0, 16)}→${e.endDate.slice(0, 16)} | ${e.venueName ?? e.address ?? "online"} | ${e.rsvps} RSVPs`) },
                detail: `Found ${plural(items.length, "event")}`,
            };
        },
    }),

    defineTool({
        name: "find_announcements",
        description: "List the brand's OWN announcements (posts to fans). Returns a ref and one line per announcement.",
        schema: z.object({ text: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) }),
        label: () => "Checking your announcements…",
        run: async (a, run) => {
            const rows = await db.creatorAnnouncement.findMany({
                where: { creatorId: run.brand.creatorId, ...(a.text && { title: { contains: a.text, mode: "insensitive" } }) },
                orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
                take: a.limit,
                select: { id: true, title: true, body: true, pinned: true, createdAt: true, expiresAt: true, _count: { select: { comments: true } } },
            });
            const items = rows.map((r) => ({
                id: r.id,
                title: r.title,
                body: r.body.length > 280 ? `${r.body.slice(0, 280)}…` : r.body,
                pinned: r.pinned,
                createdAt: r.createdAt.toISOString(),
                expiresAt: r.expiresAt?.toISOString() ?? null,
                comments: r._count.comments,
            }));
            const ref = run.addResult({ kind: "announcements", title: "Your announcements", items });
            return {
                model: { ref, announcements: items.map((r) => `${r.id} | ${r.title}${r.pinned ? " | pinned" : ""} | ${r.createdAt.slice(0, 10)} | ${r.comments} comments`) },
                detail: `Found ${plural(items.length, "announcement")}`,
            };
        },
    }),
];
