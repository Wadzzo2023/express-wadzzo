// src/workers/create-pins-worker.ts
import type { Job } from "../types/index.js";
import { db } from "../lib/db.js";
import { randomLocation } from "../lib/map.js";
import { logger } from "../lib/logger.js";
import type { Pin, PinOptions } from "../agent/types.js";
import { enrichPinFromGooglePlace } from "../lib/google-place-enrichment.js";

interface CreatePinsPayload {
    locationGroupJobId: string;
    creatorId: string;
    pins: Pin[];
    pinOptions: PinOptions;
}

async function applyGooglePlaceEnrichment(pin: Pin): Promise<Pin> {
    if (!pin.gPlaceId) return pin;

    try {
        const { imageUrl } = await enrichPinFromGooglePlace(pin.gPlaceId);

        return {
            ...pin,
            // Only overwrite if the pin doesn't already carry an explicit value
            image: pin.image ?? imageUrl ?? undefined,
            url: pin.url ?? "https://www.google.com/maps/place/?q=place_id:" + pin.gPlaceId,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
            `[create-pins-worker] Google Place enrichment failed for "${pin.title}" (${pin.gPlaceId}): ${msg}`
        );
        // Return pin as-is — enrichment is best-effort
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

        await db.locationGroup.create({
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

        for (const p of pins) log.push({ title: p.title, status: "ok" });
        completed = pins.length;

    } else {
        for (const rawPin of pins) {
            try {
                const pin = await applyGooglePlaceEnrichment(rawPin);

                const pinCount = pinOptions.pinNumber ?? 1;
                const locations = Array.from({ length: pinCount }).map(() => {
                    const loc = randomLocation(pin.latitude, pin.longitude, pin.radius ?? 2);
                    return {
                        latitude: loc.latitude,
                        longitude: loc.longitude,
                        autoCollect: pinOptions.autoCollect,
                    };
                });

                await db.locationGroup.create({
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

                log.push({ title: pin.title, status: "ok" });
                completed++;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.push({ title: rawPin.title, status: "error", error: msg });
                logger.warn(`[create-pins-worker] Failed pin "${rawPin.title}": ${msg}`);
            }

            // progress update after every pin — same as old QStash handler
            await db.locationGroupJob.update({
                where: { id: locationGroupJobId },
                data: {
                    completed,
                    log,
                    status: completed === pins.length ? "completed" : "processing",
                },
            });

            if (completed % 10 === 0 && completed < pins.length) {
                await new Promise((resolve) => setTimeout(resolve, 4000));
            }
        }
    }

    const anyFailed = log.some((l) => l.status === "error");
    await db.locationGroupJob.update({
        where: { id: locationGroupJobId },
        data: {
            status: anyFailed ? "failed" : "completed",
            completed,
            log,
            ...(anyFailed && {
                error: `${log.filter((l) => l.status === "error").length} pin(s) failed`,
            }),
        },
    });

    return { completed, failed: log.filter((l) => l.status === "error").length };
}



