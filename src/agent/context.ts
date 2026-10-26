// src/agent/context.ts
//
// What the agent knows about the artist before the person says anything: who
// they are, what they already have on the map, and their usual pin settings.
// Every query is scoped to the one artist.

import { db } from "../lib/db";
import type { PinTypeName } from "./contract";
import { PUBLIC_PINS } from "./tools/scope";

export type BrandContext = {
    creatorId: string;
    name: string;
    bio: string | null;
    counts: {
        activePins: number;
        upcomingPins: number;
        expiredPins: number;
        inReviewPins: number;
        hotspotsActive: number;
        hotspotsPaused: number;
    };
    pinTypes: Partial<Record<PinTypeName, number>>;
    recentPins: { title: string; type: PinTypeName; createdAt: Date }[];
    habits: { type: PinTypeName; durationDays: number; autoCollect: boolean; pinNumber: number } | null;
};

/** Loads the artist. Throws if it doesn't exist. */
export async function loadBrandContext(creatorId: string): Promise<BrandContext> {
    const brand = await db.creator.findUnique({ where: { id: creatorId }, select: { name: true, bio: true } });
    if (!brand) throw new Error("Artist not found");

    const now = new Date();
    const live = { creatorId, hidden: false, ...PUBLIC_PINS } as const;
    const [active, upcoming, expired, inReview, hotspotsActive, hotspotsPaused, byType, recent] = await Promise.all([
        db.locationGroup.count({ where: { ...live, approved: true, startDate: { lte: now }, endDate: { gte: now } } }),
        db.locationGroup.count({ where: { ...live, approved: true, startDate: { gt: now } } }),
        db.locationGroup.count({ where: { ...live, endDate: { lt: now } } }),
        db.locationGroup.count({ where: { ...live, endDate: { gte: now }, approved: null } }),
        db.hotspot.count({ where: { creatorId, hidden: false, isActive: true } }),
        db.hotspot.count({ where: { creatorId, hidden: false, isActive: false } }),
        db.locationGroup.groupBy({ by: ["type"], where: { ...live, endDate: { gte: now } }, _count: { _all: true } }),
        db.locationGroup.findMany({
            where: live,
            orderBy: { createdAt: "desc" },
            take: 40,
            select: { title: true, type: true, createdAt: true, startDate: true, endDate: true, locations: { select: { autoCollect: true } } },
        }),
    ]);

    return {
        creatorId,
        name: brand.name,
        bio: brand.bio,
        counts: {
            activePins: active,
            upcomingPins: upcoming,
            expiredPins: expired,
            inReviewPins: inReview,
            hotspotsActive,
            hotspotsPaused,
        },
        pinTypes: Object.fromEntries(byType.map((r) => [r.type, r._count._all])),
        recentPins: recent.slice(0, 6).map((p) => ({ title: p.title, type: p.type as PinTypeName, createdAt: p.createdAt })),
        habits: habitsOf(recent),
    };
}

/** The artist's usual settings, from its recent pins (null when it has none). */
function habitsOf(pins: { type: string; startDate: Date; endDate: Date; locations: { autoCollect: boolean }[] }[]): BrandContext["habits"] {
    if (pins.length === 0) return null;
    const most = <T,>(values: T[]) => {
        const counts = new Map<T, number>();
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    };
    const days = pins.map((p) => Math.max(1, Math.round((p.endDate.getTime() - p.startDate.getTime()) / 86_400_000)));
    // Long-lived pins (the 100-year default) mean "no end date" — cap for a readable habit.
    const sorted = [...days].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const auto = pins.flatMap((p) => p.locations.map((l) => l.autoCollect));
    return {
        type: most(pins.map((p) => p.type)) as PinTypeName,
        durationDays: Math.min(median, 3650),
        autoCollect: auto.length > 0 && auto.filter(Boolean).length > auto.length / 2,
        pinNumber: Math.max(1, Math.round(pins.reduce((s, p) => s + p.locations.length, 0) / pins.length)),
    };
}
