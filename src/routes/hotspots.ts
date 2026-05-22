import {
    Router,
    type Request,
    type Response,
    type NextFunction,
    type RequestHandler,
    type IRouter,
} from "express";
import { z } from "zod";
import { ItemPrivacy } from "@prisma/client";
import { db } from "../lib/db";
import { hotspotScheduler } from "../lib/hotspot-scheduler";
import { dropPinsForHotspot } from "../lib/hotspot-drop";
import { generateRandomLocations } from "../lib/map";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── asyncHandler ─────────────────────────────────────────────────────────────
// Wraps an async route callback so it:
//   1. Returns void  — satisfies @typescript-eslint/no-misused-promises
//   2. Forwards any thrown error to Express next(err) automatically

function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_ASSET_NUM = -10;

// ─── Validation schemas ───────────────────────────────────────────────────────

const CreateHotspotSchema = z.object({
    creatorId: z.string().min(1),
    title: z.string().min(3),
    description: z.string().optional(),
    image: z.string().url().optional(),
    url: z.string().url().optional(),
    type: z.string().optional(),
    dropEveryDays: z.number().int().min(1),
    pinDurationDays: z.number().int().min(1),
    hotspotStartDate: z.string().datetime(),
    hotspotEndDate: z.string().datetime(),
    pinNumber: z.number().int().min(1),
    pinCollectionLimit: z.number().int().min(0),
    autoCollect: z.boolean(),
    multiPin: z.boolean().optional(),
    hotspotShape: z.enum(["circle", "rectangle", "polygon"]),
    geoJson: z.unknown().optional(),
    token: z.number().optional(),
    tier: z.string().optional(),
});

const CreatorIdBodySchema = z.object({
    creatorId: z.string().min(1),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTier(tier?: string): { privacy: ItemPrivacy; tierId: number | undefined } {
    if (!tier || tier === "public") return { privacy: ItemPrivacy.PUBLIC, tierId: undefined };
    if (tier === "private") return { privacy: ItemPrivacy.PRIVATE, tierId: undefined };
    return { privacy: ItemPrivacy.TIER, tierId: Number(tier) };
}

// ─── POST /hotspots ───────────────────────────────────────────────────────────

router.post(
    "/",
    asyncHandler(async (req, res) => {
        const parse = CreateHotspotSchema.safeParse(req.body);
        if (!parse.success) {
            res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
            return;
        }

        const input = parse.data;
        const { creatorId } = input;
        const { privacy, tierId } = resolveTier(input.tier);

        let assetId: number | undefined = input.token;
        let pageAsset = false;
        if (input.token === PAGE_ASSET_NUM) { assetId = undefined; pageAsset = true; }

        const now = new Date();
        const hotspotStartDate = new Date(input.hotspotStartDate);
        const hotspotEndDate = new Date(input.hotspotEndDate);
        const firstDropEnd = new Date(now.getTime() + input.pinDurationDays * 86_400_000);

        const hotspot = await db.hotspot.create({
            data: {
                creatorId,
                autoCollect: input.autoCollect,
                dropEveryDays: input.dropEveryDays,
                pinDurationDays: input.pinDurationDays,
                hotspotStartDate,
                hotspotEndDate,
                shape: input.hotspotShape,
                geoJson: input.geoJson ?? null,
                isActive: true,
                locationGroups: {
                    create: {
                        creatorId,
                        title: input.title,
                        description: input.description,
                        image: input.image,
                        link: input.url,
                        type: input.type ?? "OTHER",
                        privacy,
                        multiPin: input.multiPin ?? false,
                        assetId,
                        pageAsset,
                        latitude: 0,
                        longitude: 0,
                        radius: 0,
                        limit: input.pinCollectionLimit,
                        remaining: input.pinCollectionLimit,
                        subscriptionId: tierId,
                        startDate: now,
                        endDate: firstDropEnd,
                        approved: true,
                        locations: {
                            createMany: {
                                data: generateRandomLocations(
                                    input.hotspotShape,
                                    (input.geoJson as never) ?? null,
                                    input.pinNumber
                                ).map((loc) => ({
                                    autoCollect: input.autoCollect,
                                    latitude: loc.latitude,
                                    longitude: loc.longitude,
                                })),
                            },
                        },
                    },
                },
            },
        });

        const daysRemaining = (hotspotEndDate.getTime() - now.getTime()) / 86_400_000;
        if (daysRemaining > input.dropEveryDays) {
            hotspotScheduler.start(hotspot.id, creatorId, input.dropEveryDays);
            logger.info(`[hotspots] Schedule started for hotspot=${hotspot.id}`);
        }

        res.status(201).json({ hotspotId: hotspot.id });
    })
);

// ─── GET /hotspots?creatorId= ─────────────────────────────────────────────────

router.get(
    "/",
    asyncHandler(async (req, res) => {
        const creatorId = req.query.creatorId as string | undefined;
        if (!creatorId) {
            res.status(400).json({ error: "creatorId query param is required" });
            return;
        }

        const hotspots = await db.hotspot.findMany({
            where: { creatorId, hidden: false },
            orderBy: { createdAt: "desc" },
            include: { _count: { select: { locationGroups: true } } },
        });

        res.json({
            hotspots: hotspots.map((h) => ({
                id: h.id,
                isActive: h.isActive,
                dropEveryDays: h.dropEveryDays,
                pinDurationDays: h.pinDurationDays,
                hotspotStartDate: h.hotspotStartDate,
                hotspotEndDate: h.hotspotEndDate,
                shape: h.shape,
                autoCollect: h.autoCollect,
                totalDrops: h._count.locationGroups,
                hasSchedule: hotspotScheduler.has(h.id),
                createdAt: h.createdAt,
            })),
        });
    })
);

// ─── GET /hotspots/:id?creatorId= ─────────────────────────────────────────────

router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const creatorId = req.query.creatorId as string | undefined;
        if (!creatorId) {
            res.status(400).json({ error: "creatorId query param is required" });
            return;
        }

        const hotspot = await db.hotspot.findFirst({
            where: { id: req.params.id, creatorId },
            include: {
                locationGroups: {
                    where: { hidden: false },
                    orderBy: { startDate: "desc" },
                    include: {
                        locations: {
                            where: { hidden: false },
                            include: { consumers: true },
                        },
                    },
                },
            },
        });

        if (!hotspot) { res.status(404).json({ error: "Hotspot not found" }); return; }

        res.json({ ...hotspot, hasSchedule: hotspotScheduler.has(hotspot.id) });
    })
);

// ─── POST /hotspots/:id/pause ─────────────────────────────────────────────────

router.post(
    "/:id/pause",
    asyncHandler(async (req, res) => {
        const parse = CreatorIdBodySchema.safeParse(req.body);
        if (!parse.success) {
            res.status(400).json({ error: "creatorId is required in request body" });
            return;
        }

        const { creatorId } = parse.data;
        const hotspot = await db.hotspot.findFirst({
            where: { id: req.params.id, creatorId },
            select: { id: true },
        });
        if (!hotspot) { res.status(404).json({ error: "Hotspot not found" }); return; }

        hotspotScheduler.pause(req.params.id);
        await db.hotspot.update({ where: { id: req.params.id }, data: { isActive: false } });

        logger.info(`[hotspots] Paused hotspot=${req.params.id} creator=${creatorId}`);
        res.json({ ok: true, hotspotId: req.params.id, isActive: false });
    })
);

// ─── POST /hotspots/:id/resume ────────────────────────────────────────────────

router.post(
    "/:id/resume",
    asyncHandler(async (req, res) => {
        const parse = CreatorIdBodySchema.safeParse(req.body);
        if (!parse.success) {
            res.status(400).json({ error: "creatorId is required in request body" });
            return;
        }

        const { creatorId } = parse.data;
        const hotspot = await db.hotspot.findFirst({
            where: { id: req.params.id, creatorId },
            select: { id: true, dropEveryDays: true },
        });
        if (!hotspot) { res.status(404).json({ error: "Hotspot not found" }); return; }

        if (!hotspotScheduler.has(req.params.id)) {
            hotspotScheduler.start(req.params.id, creatorId, hotspot.dropEveryDays);
        } else {
            hotspotScheduler.resume(req.params.id);
        }

        await db.hotspot.update({ where: { id: req.params.id }, data: { isActive: true } });

        logger.info(`[hotspots] Resumed hotspot=${req.params.id} creator=${creatorId}`);
        res.json({ ok: true, hotspotId: req.params.id, isActive: true });
    })
);

// ─── DELETE /hotspots/:id ─────────────────────────────────────────────────────

router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
        const parse = CreatorIdBodySchema.safeParse(req.body);
        if (!parse.success) {
            res.status(400).json({ error: "creatorId is required in request body" });
            return;
        }

        const { creatorId } = parse.data;
        const hotspot = await db.hotspot.findFirst({
            where: { id: req.params.id, creatorId },
            select: { id: true },
        });
        if (!hotspot) { res.status(404).json({ error: "Hotspot not found" }); return; }

        hotspotScheduler.stop(req.params.id);

        await db.locationGroup.updateMany({
            where: { hotspotId: req.params.id },
            data: { hidden: true },
        });
        await db.hotspot.update({
            where: { id: req.params.id },
            data: { isActive: false, hidden: true },
        });

        logger.info(`[hotspots] Deleted hotspot=${req.params.id} creator=${creatorId}`);
        res.json({ ok: true, hotspotId: req.params.id });
    })
);

// ─── POST /hotspots/:id/drop ──────────────────────────────────────────────────

router.post(
    "/:id/drop",
    asyncHandler(async (req, res) => {
        const parse = CreatorIdBodySchema.safeParse(req.body);
        if (!parse.success) {
            res.status(400).json({ error: "creatorId is required in request body" });
            return;
        }

        const { creatorId } = parse.data;
        const hotspot = await db.hotspot.findFirst({
            where: { id: req.params.id, creatorId },
            select: { id: true },
        });
        if (!hotspot) { res.status(404).json({ error: "Hotspot not found" }); return; }

        const result = await dropPinsForHotspot(db, req.params.id);

        if ("expired" in result && result.expired) {
            hotspotScheduler.stop(req.params.id);
            res.json({ ok: false, reason: "expired" });
            return;
        }

        logger.info(`[hotspots] Manual drop hotspot=${req.params.id}`, result);
        res.json({ ok: true, result });
    })
);

export default router;