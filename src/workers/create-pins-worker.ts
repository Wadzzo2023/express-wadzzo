// src/workers/create-pins-worker.ts
import type { Job } from "../types/index.js";
import { db } from "../lib/db.js";
import { randomLocation } from "../lib/map.js";
import { logger } from "../lib/logger.js";
import type { Pin, PinOptions } from "../agent/types.js";
import { enrichPinFromGooglePlace } from "../lib/google-place-enrichment.js";
import pLimit from "p-limit";

const ENRICHMENT_CONCURRENCY = 5;
const DB_WRITE_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? "5", 10);
const PROGRESS_UPDATE_INTERVAL = 5;

interface CreatePinsPayload {
    locationGroupJobId: string;
    creatorId: string;
    pins: Pin[];
    pinOptions: PinOptions;
}

async function preCreateTags(
    creatorId: string,
    tagLabels: string[]
): Promise<{ id: string; name: string }[]> {
    const tags: { id: string; name: string }[] = [];
    for (const label of tagLabels) {
        const name = label.toLowerCase().replace(/\s+/g, "-");
        try {
            const tag = await db.locationTag.upsert({
                where: { name },
                create: { name, label, creatorId },
                update: {},
            });
            tags.push({ id: tag.id, name: tag.name });
        } catch (err) {
            logger.warn(`[tags] Failed to create tag "${label}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return tags;
}

async function linkTagsToLocationGroup(
    locationGroupId: string,
    tagIds: string[]
): Promise<void> {
    const data = tagIds.map((tagId) => ({ locationGroupId, tagId }));
    try {
        await db.locationGroupTag.createMany({ data, skipDuplicates: true });
    } catch (err) {
        logger.warn(`[tags] Failed to link tags to ${locationGroupId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function applyGooglePlaceEnrichment(pin: Pin): Promise<Pin> {
    if (!pin.gPlaceId) return pin;

    try {
        const { imageUrl } = await enrichPinFromGooglePlace(pin.gPlaceId);

        return {
            ...pin,
            image: pin.image ?? imageUrl ?? undefined,
            url: pin.url ?? "https://www.google.com/maps/place/?q=place_id:" + pin.gPlaceId,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
            `[create-pins-worker] Google Place enrichment failed for "${pin.title}" (${pin.gPlaceId}): ${msg}`
        );
        return pin;
    }
}

export async function runCreatePinsJob(job: Job): Promise<unknown> {
    const { locationGroupJobId, creatorId, pins, pinOptions } =
        job.payload as unknown as CreatePinsPayload;

    await db.locationGroupJob.update({
        where: { id: locationGroupJobId },
        data: { status: "processing", total: pins.length },
    });

    // ── generate tags ONCE from the first pin ──
    const firstPin = pins[0];
    let jobTags: string[] = [];

    const dbCached = await db.locationTagCache.findUnique({
        where: { title: firstPin.title },
    });

    if (dbCached) {
        logger.info(`[tags] cache hit: "${firstPin.title}" → ${dbCached.tags.join(", ")}`);
        jobTags = dbCached.tags;
    } else {
        logger.info(`[tags] generating from first pin: "${firstPin.title}"`);
        jobTags = await callOpenAI(firstPin);

        await db.locationTagCache.upsert({
            where: { title: firstPin.title },
            create: { title: firstPin.title, tags: jobTags },
            update: {
                tags: jobTags,
            },
        });

        logger.info(`[tags] cached: "${firstPin.title}" → ${jobTags.join(", ")}`);
    }

    // ── pre-create all tags once, reuse IDs for every pin ──
    const tagRecords = await preCreateTags(creatorId, jobTags);
    const tagIds = tagRecords.map((t) => t.id);

    const log: { title: string; status: string; error?: string }[] = [];
    let completed = 0;

    if (pinOptions.groupingMode === "single-group") {
        const base = await applyGooglePlaceEnrichment(pins[0]);

        const allLocations = pins.map((p) => {
            const loc = randomLocation(p.latitude, p.longitude, p.radius ?? 2);
            return {
                latitude: loc.latitude,
                longitude: loc.longitude,
                autoCollect: pinOptions.autoCollect,
            };
        });

        const locationGroup = await db.locationGroup.create({
            data: {
                creatorId,
                title: base.title,
                description: base.description,
                startDate: new Date(base.startDate),
                endDate: new Date(base.endDate),
                limit: base.pinCollectionLimit ?? 999999,
                remaining: base.pinCollectionLimit ?? 999999,
                image: base.image ?? null,
                latitude: base.latitude,
                longitude: base.longitude,
                radius: base.radius ?? 2,
                link: base.url ?? null,
                multiPin: false,
                type: (base.type ?? "OTHER") as never,
                locations: { createMany: { data: allLocations } },
            },
        });
        await linkTagsToLocationGroup(locationGroup.id, tagIds);

        for (const p of pins) log.push({ title: p.title, status: "ok" });
        completed = pins.length;

    } else {
        // ── Phase 1: enrich all pins in parallel ──
        const enrichLimit = pLimit(ENRICHMENT_CONCURRENCY);
        const enrichedPins = await Promise.all(
            pins.map((rawPin) => enrichLimit(() => applyGooglePlaceEnrichment(rawPin)))
        );

        // ── Phase 2: create location groups in parallel batches ──
        const writeLimit = pLimit(DB_WRITE_CONCURRENCY);

        await Promise.all(
            enrichedPins.map((pin, idx) =>
                writeLimit(async () => {
                    try {
                        const pinCount = pinOptions.pinNumber ?? 1;
                        const locations = Array.from({ length: pinCount }).map(() => {
                            const loc = randomLocation(pin.latitude, pin.longitude, pin.radius ?? 2);
                            return {
                                latitude: loc.latitude,
                                longitude: loc.longitude,
                                autoCollect: pinOptions.autoCollect,
                            };
                        });

                        const locationGroup = await db.locationGroup.create({
                            data: {
                                creatorId,
                                title: pin.title,
                                description: pin.description,
                                startDate: new Date(pin.startDate),
                                endDate: new Date(pin.endDate),
                                limit: pin.pinCollectionLimit ?? 999999,
                                remaining: pin.pinCollectionLimit ?? 999999,
                                image: pin.image ?? null,
                                latitude: pin.latitude,
                                longitude: pin.longitude,
                                radius: pin.radius ?? 2,
                                link: pin.url ?? null,
                                multiPin: false,
                                type: (pin.type ?? "OTHER") as never,
                                locations: { createMany: { data: locations } },
                            },
                        });
                        await linkTagsToLocationGroup(locationGroup.id, tagIds);

                        log[idx] = { title: pin.title, status: "ok" };
                        completed++;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        log[idx] = { title: pin.title, status: "error", error: msg };
                        logger.warn(`[create-pins-worker] Failed pin "${pin.title}": ${msg}`);
                    }

                    if (completed % PROGRESS_UPDATE_INTERVAL === 0 || completed === pins.length) {
                        await db.locationGroupJob.update({
                            where: { id: locationGroupJobId },
                            data: {
                                completed,
                                log: log.filter(Boolean),
                                status: completed === pins.length ? "completed" : "processing",
                            },
                        });
                    }
                })
            )
        );

        // ── Phase 3: batch cache all unique pin titles ──
        const uniqueTitles = [...new Set(pins.map((p) => p.title))];
        await Promise.all(
            uniqueTitles.map((title) =>
                db.locationTagCache.upsert({
                    where: { title },
                    create: { title, tags: jobTags },
                    update: { tags: jobTags },
                }).catch(() => { /* non-critical */ })
            )
        );
    }

    const anyFailed = log.some((l) => l?.status === "error");
    await db.locationGroupJob.update({
        where: { id: locationGroupJobId },
        data: {
            status: anyFailed ? "failed" : "completed",
            completed,
            log: log.filter(Boolean),
            ...(anyFailed && {
                error: `${log.filter((l) => l?.status === "error").length} pin(s) failed`,
            }),
        },
    });

    return { completed, failed: log.filter((l) => l?.status === "error").length };
}





async function callOpenAI(pin: {
    title: string;
    description: string | null | undefined;
    type: string;
    latitude: number;
    longitude: number;
}): Promise<string[]> {
    let locationContext = "";
    try {
        const geoRes = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${pin.latitude}&lon=${pin.longitude}&format=json&addressdetails=1&zoom=16`,
            { headers: { "User-Agent": "WadzzoApp/1.0" } }
        );
        const geoData = await geoRes.json() as {
            address?: { amenity?: string; leisure?: string; tourism?: string; neighbourhood?: string; suburb?: string }
        };
        const addr = geoData.address ?? {};
        locationContext = [addr.amenity, addr.leisure, addr.tourism, addr.neighbourhood ?? addr.suburb]
            .filter(Boolean).join(", ");
    } catch { /* ignore */ }

    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: "gpt-4o",
            tools: [{ type: "web_search_preview" }],
            input: `You are a location tagging expert for a map app.
Search the web to identify what this location pin really is.

Title: "${pin.title}"
Coordinates: ${pin.latitude}, ${pin.longitude}
Address context: ${locationContext || "unknown"}
Description: ${pin.description?.trim() ?? "none"}
Type: ${pin.type}

Generate exactly 7 tags users would naturally search for.
Focus ONLY on:
- Brand/creator (thomas dambo, kfc, starbucks, banksy)
- What it is (troll sculpture, fast food, hospital, market, park)
- Collection/series (thomas dambo trolls)
- Theme (outdoor art, dining, healthcare, family friendly)

Do NOT include city, state, or country tags.
Return ONLY a valid JSON array of 7 strings.`,
        }),
    });

    if (!response.ok) {
        logger.warn(`[tags] OpenAI error for "${pin.title}"`);
        return [];
    }

    const data = await response.json() as {
        output: { type: string; content?: { type: string; text: string }[] }[]
    };

    const textContent = data.output
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");

    let tags: string[] = [];
    try {
        const match = textContent.match(/\[[\s\S]*?\]/);
        if (match) {
            tags = (JSON.parse(match[0]) as unknown[])
                .map((t) => String(t).toLowerCase().trim())
                .filter((t) => t.length > 0 && t.length < 50);
        }
    } catch {
        tags = textContent
            .replace(/```json|```/g, "")
            .split(/[\n,]+/)
            .map((t) => t.replace(/^[-•*"'\[\]\s]+|["'\[\]\s]+$/g, "").toLowerCase().trim())
            .filter((t) => t.length > 0 && t.length < 50);
    }

    return [...new Set(tags)].slice(0, 7);
}
