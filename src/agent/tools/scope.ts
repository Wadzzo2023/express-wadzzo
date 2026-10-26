// src/agent/tools/scope.ts
//
// Artist-scoped reads shared by the tools. Every query here filters on the
// run's own creatorId; ids the model passes in are only ever used together
// with that filter, so an id from another brand simply matches nothing.

import type { Prisma } from "@prisma/client";
import { db } from "../../lib/db";
import type { HotspotItem, PinItem, PinStatus, PinTypeName } from "../contract";
import { inArea, type Box, type SearchArea } from "../area";

export const PIN_TYPES = ["LANDMARK", "EVENT", "EXPERIENCE", "LAUNCH", "BOUNTY", "OTHER"] as const satisfies readonly PinTypeName[];

/**
 * The artist's public pins. A private NFT-unlock pin set (restrictedToUserId)
 * belongs to one token holder: the agent never lists, edits or counts it.
 */
export const PUBLIC_PINS = { restrictedToUserId: null } as const;

export type PinFilter = {
    ids?: string[];
    text?: string;
    type?: PinTypeName;
    status?: PinStatus | "current" | "any";
    area?: SearchArea | null;
    createdInLastDays?: number;
    limit: number;
};

export function pinStatus(p: { approved: boolean | null; startDate: Date; endDate: Date }, now = new Date()): PinStatus {
    if (p.endDate < now) return "expired";
    if (p.approved === false) return "rejected";
    if (p.approved !== true) return "in_review";
    if (p.startDate > now) return "upcoming";
    return "active";
}

function statusWhere(status: PinFilter["status"], now: Date): Prisma.LocationGroupWhereInput {
    switch (status) {
        case "active":
            return { approved: true, startDate: { lte: now }, endDate: { gte: now } };
        case "upcoming":
            return { approved: true, startDate: { gt: now } };
        case "expired":
            return { endDate: { lt: now } };
        case "in_review":
            return { approved: null, endDate: { gte: now } };
        case "rejected":
            return { approved: false };
        case "any":
            return {};
        default: // "current": everything not yet expired
            return { endDate: { gte: now } };
    }
}

const boxWhere = (box: Box) => ({ latitude: { gte: box.south, lte: box.north }, longitude: { gte: box.west, lte: box.east } });

/** The brand's pins matching `filter`, newest first, and how many matched in total. */
export async function findPins(creatorId: string, filter: PinFilter): Promise<{ items: PinItem[]; total: number }> {
    const now = new Date();
    const where: Prisma.LocationGroupWhereInput = {
        creatorId,
        hidden: false,
        ...PUBLIC_PINS,
        ...statusWhere(filter.ids ? "any" : filter.status, now),
        ...(filter.ids && { id: { in: filter.ids } }),
        ...(filter.type && { type: filter.type }),
        ...(filter.text && {
            OR: [{ title: { contains: filter.text, mode: "insensitive" } }, { description: { contains: filter.text, mode: "insensitive" } }],
        }),
        ...(filter.createdInLastDays && { createdAt: { gte: new Date(now.getTime() - filter.createdInLastDays * 86_400_000) } }),
        ...(filter.area && boxWhere(filter.area.box)),
    };

    const rows = await db.locationGroup.findMany({
        where,
        orderBy: { createdAt: "desc" },
        // A polygon area is filtered after the box query, so fetch a little extra.
        take: filter.area?.rings ? filter.limit * 3 : filter.limit,
        select: {
            id: true,
            title: true,
            type: true,
            latitude: true,
            longitude: true,
            startDate: true,
            endDate: true,
            approved: true,
            image: true,
            hotspotId: true,
            locations: { where: { hidden: false }, select: { _count: { select: { consumers: { where: { hidden: false } } } } } },
        },
    });
    const inside = filter.area ? rows.filter((r) => inArea(filter.area!, r.latitude, r.longitude)) : rows;
    const total = filter.area?.rings ? inside.length : await db.locationGroup.count({ where });

    return {
        total,
        items: inside.slice(0, filter.limit).map((r) => ({
            id: r.id,
            title: r.title,
            type: r.type as PinTypeName,
            lat: r.latitude,
            lng: r.longitude,
            startDate: r.startDate.toISOString(),
            endDate: r.endDate.toISOString(),
            status: pinStatus(r, now),
            locations: r.locations.length,
            collected: r.locations.reduce((s, l) => s + l._count.consumers, 0),
            image: r.image,
            hotspotId: r.hotspotId,
        })),
    };
}

/** Ids from `ids` that are the brand's own live pins, with their titles. */
export async function ownPins(creatorId: string, ids: string[]) {
    return db.locationGroup.findMany({ where: { id: { in: ids }, creatorId, hidden: false, ...PUBLIC_PINS }, select: { id: true, title: true } });
}

export async function findHotspots(creatorId: string, opts: { ids?: string[]; text?: string; status?: "active" | "paused" | "any"; limit: number }): Promise<HotspotItem[]> {
    const rows = await db.hotspot.findMany({
        where: {
            creatorId,
            hidden: false,
            ...(opts.ids && { id: { in: opts.ids } }),
            ...(opts.status === "active" && { isActive: true }),
            ...(opts.status === "paused" && { isActive: false }),
            // A hotspot is named after its drops.
            ...(opts.text && { locationGroups: { some: { title: { contains: opts.text, mode: "insensitive" } } } }),
        },
        orderBy: { createdAt: "desc" },
        take: opts.limit,
        select: {
            id: true,
            isActive: true,
            dropEveryDays: true,
            pinDurationDays: true,
            hotspotStartDate: true,
            hotspotEndDate: true,
            autoCollect: true,
            geoJson: true,
            locationGroups: { orderBy: { createdAt: "desc" }, select: { title: true } },
        },
    });
    return rows.map((h) => ({
        id: h.id,
        title: h.locationGroups[0]?.title ?? "Hotspot",
        isActive: h.isActive,
        dropEveryDays: h.dropEveryDays,
        pinDurationDays: h.pinDurationDays,
        startDate: h.hotspotStartDate.toISOString(),
        endDate: h.hotspotEndDate.toISOString(),
        autoCollect: h.autoCollect,
        drops: h.locationGroups.length,
        geoJson: h.geoJson,
    }));
}

/** Pins within `metres` of a point, to flag places the brand already covers. */
export async function pinsNear(creatorId: string, box: Box) {
    return db.locationGroup.findMany({
        where: { creatorId, hidden: false, ...PUBLIC_PINS, endDate: { gte: new Date() }, ...boxWhere(box) },
        select: { latitude: true, longitude: true },
        take: 5000,
    });
}
