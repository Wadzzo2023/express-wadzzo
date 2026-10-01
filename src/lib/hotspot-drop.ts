/**
 * src/lib/hotspot-drop.ts
 *
 * Pure DB function that executes one drop cycle for a hotspot.
 * No QStash, no HTTP — just Prisma writes.
 * Called by hotspot-scheduler on each cron tick.
 *
 * Extracted from the original pin.ts `dropPinsForHotspot` export.
 */

import type { PrismaClient } from "@prisma/client";
import { db } from "./db.js";
import { generateRandomLocations } from "../lib/map.js";
import { logger } from "./logger.js";
import type * as GeoJSON from "geojson";

// ─── Return shapes ────────────────────────────────────────────────────────────

export type DropResult =
    | { skipped: true; reason?: string }
    | { expired: true }
    | { droppedAt: string; count: number };

/** Cron ticks can fire a little early or late. */
const START_TOLERANCE_MS = 60_000;

/**
 * A hotspot that starts in the future gets its first drop created up front,
 * hidden, dated for the start (it carries the title/image/etc. every later drop
 * copies). It's recognisable because it was created well before its start;
 * once released, startDate and createdAt are both reset to the release time.
 */
export function isPendingFirstDrop(group: { hidden: boolean; startDate: Date; createdAt: Date }) {
    return group.hidden && group.startDate.getTime() - group.createdAt.getTime() > START_TOLERANCE_MS;
}

async function findPendingFirstDrop(prisma: PrismaClient, hotspotId: string) {
    const hidden = await prisma.locationGroup.findMany({
        where: { hotspotId, hidden: true },
        select: { id: true, hidden: true, startDate: true, createdAt: true, _count: { select: { locations: true } } },
        orderBy: { createdAt: "asc" },
    });
    return hidden.find(isPendingFirstDrop) ?? null;
}

// ─── Core drop function ───────────────────────────────────────────────────────

/**
 * Executes one pin-drop cycle for the given hotspot.
 *
 * Flow:
 *  1. Fetch hotspot — bail if not found or inactive
 *  2. Check end date — if expired, mark inactive and return { expired: true }
 *  3. Read most-recent LocationGroup for content metadata
 *  4. Generate fresh random pin coordinates inside the hotspot shape
 *  5. Write a new LocationGroup + Locations to DB
 *
 * @param prisma  Prisma client instance (pass `db` from lib/db.ts)
 * @param hotspotId  The hotspot to drop for
 */
export async function dropPinsForHotspot(
    prisma: PrismaClient,
    hotspotId: string,
    /** `force` skips the one-drop-per-cycle guard (manual drops). */
    options: { force?: boolean } = {}
): Promise<DropResult> {
    // ── Step 1: Load hotspot ───────────────────────────────────────────────────
    const hotspot = await prisma.hotspot.findUnique({
        where: { id: hotspotId },
    });

    if (!hotspot) {
        logger.warn(`[hotspot-drop] Hotspot not found: ${hotspotId}`);
        return { skipped: true, reason: "hotspot not found" };
    }

    if (!hotspot.isActive) {
        logger.info(`[hotspot-drop] Hotspot inactive, skipping: ${hotspotId}`);
        return { skipped: true, reason: "hotspot inactive" };
    }

    const now = new Date();

    // ── Step 2: Check expiry ───────────────────────────────────────────────────
    if (now > new Date(hotspot.hotspotEndDate)) {
        logger.info(`[hotspot-drop] Hotspot expired: ${hotspotId}`);
        await prisma.hotspot.update({
            where: { id: hotspotId },
            data: { isActive: false },
        });
        return { expired: true };
    }

    // ── Step 2b: Not started yet ───────────────────────────────────────────────
    const startAt = new Date(hotspot.hotspotStartDate);
    if (now.getTime() < startAt.getTime() - START_TOLERANCE_MS) {
        return { skipped: true, reason: "hotspot has not started yet" };
    }

    // ── Step 2c: Reveal the first drop created ahead of the start date ─────────
    const pending = await findPendingFirstDrop(prisma, hotspotId);
    if (pending) {
        await prisma.locationGroup.update({
            where: { id: pending.id },
            data: {
                hidden: false,
                startDate: now,
                createdAt: now, // no longer "created ahead of its start" (see isPendingFirstDrop)
                endDate: new Date(now.getTime() + hotspot.pinDurationDays * 86_400_000),
            },
        });
        logger.info(`[hotspot-drop] Released first drop for hotspot=${hotspotId}`);
        return { droppedAt: now.toISOString(), count: pending._count.locations };
    }

    // ── Step 2d: One drop per cycle ────────────────────────────────────────────
    // The cron tick and the first-drop timer (or a restart) can fire within
    // moments of each other; only the first of them drops.
    if (!options.force) {
        const latest = await prisma.locationGroup.findFirst({
            where: { hotspotId, hidden: false },
            orderBy: { startDate: "desc" },
            select: { startDate: true },
        });
        const cycleMs = hotspot.dropEveryDays * 86_400_000;
        if (latest && now.getTime() - latest.startDate.getTime() < cycleMs - 10 * 60_000) {
            return { skipped: true, reason: "already dropped this cycle" };
        }
    }

    // ── Step 3: Read latest group for content fields ───────────────────────────
    const lastGroup = await prisma.locationGroup.findFirst({
        where: { hotspotId },
        orderBy: { startDate: "desc" },
        include: { _count: { select: { locations: true } } },
    });

    if (!lastGroup) {
        logger.warn(`[hotspot-drop] No LocationGroup found for hotspot: ${hotspotId}`);
        return { skipped: true, reason: "no locationGroup found" };
    }

    // ── Step 4: Generate pin coordinates ──────────────────────────────────────
    const pinEndDate = new Date(now.getTime() + hotspot.pinDurationDays * 86_400_000);

    const rawLocations = generateRandomLocations(
        hotspot.shape as "circle" | "rectangle" | "polygon",
        hotspot.geoJson as GeoJSON.Feature | null,
        // Same number of pins as the previous drop (the brand's "pins per drop").
        // Not `limit` — that's the collection limit, and 0 means unlimited.
        Math.max(1, lastGroup._count.locations)
    );

    const locations = rawLocations.map((loc) => ({
        latitude: loc.latitude,
        longitude: loc.longitude,
        autoCollect: hotspot.autoCollect,
    }));

    // ── Step 5: Write new LocationGroup + Locations ────────────────────────────
    await prisma.locationGroup.create({
        data: {
            hotspotId: hotspot.id,
            creatorId: lastGroup.creatorId,
            title: lastGroup.title,
            description: lastGroup.description,
            image: lastGroup.image,
            optimizedImage: lastGroup.optimizedImage,
            link: lastGroup.link,
            type: lastGroup.type,
            latitude: lastGroup.latitude,
            longitude: lastGroup.longitude,
            radius: lastGroup.radius,
            approved: true,
            privacy: lastGroup.privacy,
            multiPin: lastGroup.multiPin,
            assetId: lastGroup.assetId,
            pageAsset: lastGroup.pageAsset,
            limit: lastGroup.limit,
            remaining: lastGroup.limit,
            subscriptionId: lastGroup.subscriptionId,
            startDate: now,
            endDate: pinEndDate,
            locations: {
                createMany: { data: locations },
            },
        },
    });

    logger.info(
        `[hotspot-drop] Dropped ${locations.length} pins for hotspot=${hotspotId}`
    );

    return { droppedAt: now.toISOString(), count: locations.length };
}