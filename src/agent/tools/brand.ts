// src/agent/tools/brand.ts — reading the artist's own pins and hotspots.

import { z } from "zod";
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
            "Search the artist's OWN pins (drops) by text, type, status, area and age. Use before editing, deleting or reporting on pins. " +
            "Returns a ref (for show_results, propose_pin_changes, pin_stats) and one line per pin: id | title | type | status | collections.",
        schema: z.object({
            text: z.string().optional().describe("Words in the title or description"),
            type: z.enum(PIN_TYPES).optional(),
            status: z.enum(STATUSES).default("current").describe('"current" = not expired (default); "any" includes expired'),
            where: z.string().optional().describe("Limit to an area (a place name). Omit for anywhere."),
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
        description: "List the artist's OWN hotspots (areas that drop pins on a schedule). Returns a ref and one line per hotspot: id | name | active/paused | schedule.",
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
];
