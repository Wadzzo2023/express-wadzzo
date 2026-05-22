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
    hotspotId: string
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

    // ── Step 3: Read latest group for content fields ───────────────────────────
    const lastGroup = await prisma.locationGroup.findFirst({
        where: { hotspotId },
        orderBy: { startDate: "desc" },
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
        lastGroup.limit ?? 0
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