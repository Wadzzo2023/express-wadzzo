// src/agent/tools/analytics.ts — collection numbers for the artist's own pins.
//
// One collection = one LocationConsumer row on a live pin, dated by createdAt.
// The model only ever sees totals; collectors' names and emails go straight to
// the card the brand sees, never into the model's context.

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../../lib/db";
import type { ReportBar, ReportStat } from "../contract";
import type { Run } from "../run";
import { defineTool, plural } from "./define";

const FROM = Prisma.sql`"LocationConsumer" c
  JOIN "Location" l ON l.id = c."locationId"
  JOIN "LocationGroup" g ON g.id = l."locationGroupId"`;

function where(creatorId: string, since: Date | null, until: Date | null, pinIds: string[] | null) {
    return Prisma.sql`c.hidden = false AND l.hidden = false AND g.hidden = false AND g."creatorId" = ${creatorId}
      AND g."restrictedToUserId" IS NULL
      ${since ? Prisma.sql`AND c."createdAt" >= ${since}` : Prisma.empty}
      ${until ? Prisma.sql`AND c."createdAt" < ${until}` : Prisma.empty}
      ${pinIds ? Prisma.sql`AND g.id IN (${Prisma.join(pinIds)})` : Prisma.empty}`;
}

type Totals = { collections: number; collectors: number; redeemed: number };

async function totals(creatorId: string, since: Date | null, until: Date | null, pinIds: string[] | null): Promise<Totals> {
    const [row] = await db.$queryRaw<Totals[]>`
      SELECT COUNT(*)::int AS collections, COUNT(DISTINCT c."userId")::int AS collectors,
             COUNT(*) FILTER (WHERE c."isRedeemed")::int AS redeemed
      FROM ${FROM} WHERE ${where(creatorId, since, until, pinIds)}`;
    return row ?? { collections: 0, collectors: 0, redeemed: 0 };
}

/** Pins to report on: explicit ids, or a pins ref from find_pins (both limited to the brand's own). */
function pinScope(run: Run, a: { pinIds?: string[]; ref?: string }): string[] | null {
    if (a.ref) {
        const ids = run.result(a.ref, "pins").items.map((p) => p.id);
        return ids.length ? ids : ["-"]; // an empty set must match nothing, not everything
    }
    return a.pinIds?.length ? a.pinIds : null;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const change = (now: number, before: number) => (before === 0 ? (now > 0 ? "new" : "—") : `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%`);

const scopeFields = {
    days: z.number().int().min(0).max(3650).default(30).describe("Look-back period in days; 0 = all time"),
    pinIds: z.array(z.string()).max(200).optional().describe("Only these pins (ids from find_pins)"),
    ref: z.string().optional().describe("Only the pins in this find_pins ref"),
};

export const analyticsTools = [
    defineTool({
        name: "collection_report",
        description:
            "Collection numbers for the brand's pins: totals (collections, unique collectors, redeemed, vs the previous period) " +
            'and a breakdown by day, week, pin or pin type. Returns a ref to show as a report card.',
        schema: z.object({ ...scopeFields, by: z.enum(["day", "week", "pin", "type"]).default("day") }),
        label: (a) => `Crunching collection numbers${a.days ? ` for the last ${a.days} days` : ""}…`,
        run: async (a, run) => {
            const creatorId = run.brand.creatorId;
            const pinIds = pinScope(run, a);
            const now = new Date();
            const since = a.days ? new Date(now.getTime() - a.days * 86_400_000) : null;
            const prevSince = a.days ? new Date(now.getTime() - 2 * a.days * 86_400_000) : null;
            const w = where(creatorId, since, null, pinIds);

            const [current, previous, rows] = await Promise.all([
                totals(creatorId, since, null, pinIds),
                since ? totals(creatorId, prevSince, since, pinIds) : Promise.resolve(null),
                a.by === "pin"
                    ? db.$queryRaw<{ label: string; n: number }[]>`SELECT g.title AS label, COUNT(*)::int AS n FROM ${FROM} WHERE ${w} GROUP BY g.id, g.title ORDER BY n DESC LIMIT 12`
                    : a.by === "type"
                      ? db.$queryRaw<{ label: string; n: number }[]>`SELECT g.type::text AS label, COUNT(*)::int AS n FROM ${FROM} WHERE ${w} GROUP BY 1 ORDER BY n DESC`
                      : a.by === "week"
                        ? db.$queryRaw<{ label: string; n: number }[]>`SELECT to_char(date_trunc('week', c."createdAt"), 'YYYY-MM-DD') AS label, COUNT(*)::int AS n FROM ${FROM} WHERE ${w} GROUP BY 1 ORDER BY 1`
                        : db.$queryRaw<{ label: string; n: number }[]>`SELECT to_char(c."createdAt", 'YYYY-MM-DD') AS label, COUNT(*)::int AS n FROM ${FROM} WHERE ${w} GROUP BY 1 ORDER BY 1`,
            ]);

            const stats: ReportStat[] = [
                { label: "Collections", value: fmt(current.collections), hint: previous ? `${change(current.collections, previous.collections)} vs previous ${a.days} days` : undefined },
                { label: "Collectors", value: fmt(current.collectors), hint: previous ? `${change(current.collectors, previous.collectors)} vs previous` : undefined },
                { label: "Redeemed", value: fmt(current.redeemed) },
            ];
            const bars: ReportBar[] = rows.map((r) => ({ label: r.label, value: r.n }));
            const period = a.days ? `last ${a.days} days` : "all time";
            const byWord = { day: "per day", week: "per week", pin: "top pins", type: "by pin type" }[a.by];
            const ref = run.addResult({
                kind: "report",
                title: `Collections · ${period}${pinIds ? " · selected pins" : ""}`,
                stats,
                bars: bars.length ? { title: `Collections ${byWord}`, items: bars } : undefined,
                note: current.collections === 0 ? "No collections in this period." : undefined,
            });
            return {
                model: { ref, period, current, previous, breakdown: { by: a.by, rows: bars.slice(0, 40) } },
                detail: `${plural(current.collections, "collection")} by ${plural(current.collectors, "collector")}`,
            };
        },
    }),

    defineTool({
        name: "collectors",
        description:
            "The fans who collected the brand's pins, most active first. Their names and emails are shown to the person on a card; " +
            "you only get the counts. Returns a ref to show.",
        schema: z.object({ ...scopeFields, limit: z.number().int().min(1).max(500).default(100) }),
        label: () => "Looking up who collected your pins…",
        run: async (a, run) => {
            const pinIds = pinScope(run, a);
            const since = a.days ? new Date(Date.now() - a.days * 86_400_000) : null;
            const w = where(run.brand.creatorId, since, null, pinIds);
            const [rows, [count]] = await Promise.all([
                db.$queryRaw<{ name: string | null; email: string | null; n: number; redeemed: number; last: Date }[]>`
                  SELECT u.name, u.email, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE c."isRedeemed")::int AS redeemed, MAX(c."createdAt") AS last
                  FROM ${FROM} JOIN "User" u ON u.id = c."userId"
                  WHERE ${w} GROUP BY u.id, u.name, u.email ORDER BY n DESC, last DESC LIMIT ${a.limit}`,
                db.$queryRaw<{ total: number }[]>`SELECT COUNT(DISTINCT c."userId")::int AS total FROM ${FROM} WHERE ${w}`,
            ]);
            const total = count?.total ?? 0;
            const items = rows.map((r) => ({ name: r.name, email: r.email, collected: r.n, redeemed: r.redeemed, lastAt: r.last.toISOString() }));
            const ref = run.addResult({ kind: "collectors", title: `Top collectors · ${a.days ? `last ${a.days} days` : "all time"}`, items, total });
            return {
                model: {
                    ref,
                    totalCollectors: total,
                    listed: items.length,
                    // Counts only, no identities.
                    topCounts: items.slice(0, 10).map((c, i) => `#${i + 1}: ${c.collected} collections, ${c.redeemed} redeemed`),
                },
                detail: `Found ${plural(total, "collector")}`,
            };
        },
    }),
];
