// src/workers/transcode-audio-worker.ts
//
// Turns an asset's uploaded audio into streaming files:
//   stream/{assetId}/{random}/full.m4a      — owners (AAC 256k, faststart)
//   stream/{assetId}/{random}/preview.m4a   — everyone else (30s from previewStartSec)
//   stream/{assetId}/{random}/stems/{i}.m4a — owners' stem player (no loudnorm)
// then marks the asset READY with its real duration.
//
// This service's Prisma schema predates the streaming columns, so the Asset
// fields are read and written with SQL. Never `db:push` this schema.

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import type { Job } from "../types/index.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { addLog, setProgress } from "../lib/job-store.js";
import { uploadStreamFile } from "../lib/s3.js";
import { ffmpeg, fullArgs, previewArgs, previewWindow, probeDuration, stemArgs, streamKeys } from "../lib/transcode.js";

type SourceRow = { mediaUrl: string; demoMediaUrl: string | null; previewStartSec: number };
type StemRow = { id: number; steamUrl: string; trackIndex: number };

const STEM_CONCURRENCY = 3;

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run));
}

async function setStatus(assetId: number, status: "PROCESSING" | "FAILED") {
    await db.$executeRaw`UPDATE "Asset" SET "mediaStatus" = ${status}::"MediaStatus" WHERE id = ${assetId}`;
}

async function download(url: string, dest: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export async function runTranscodeJob(job: Job): Promise<unknown> {
    const assetId = Number(job.payload.assetId);
    const [row] = await db.$queryRaw<SourceRow[]>`
        SELECT "mediaUrl", "demoMediaUrl", "previewStartSec" FROM "Asset" WHERE id = ${assetId}`;
    if (!row) throw new Error(`Asset ${assetId} not found`);

    // Royalty items only have a sample: it becomes the preview, there is no full track.
    const hasFull = row.mediaUrl.length > 0;
    const sourceUrl = hasFull ? row.mediaUrl : row.demoMediaUrl;
    if (!sourceUrl) throw new Error(`Asset ${assetId} has no audio`);

    const dir = await mkdtemp(path.join(tmpdir(), `transcode-${assetId}-`));
    try {
        await setStatus(assetId, "PROCESSING");
        const input = path.join(dir, "source");
        await download(sourceUrl, input);
        setProgress(job.id, 20);

        const duration = await probeDuration(input);
        const keys = streamKeys(assetId);
        const fullOut = path.join(dir, "full.m4a");
        const previewOut = path.join(dir, "preview.m4a");

        if (hasFull) await ffmpeg(fullArgs(input, fullOut));
        setProgress(job.id, 60);
        await ffmpeg(previewArgs(input, previewOut, previewWindow(duration, row.previewStartSec)));
        setProgress(job.id, 80);

        if (hasFull) await uploadStreamFile(keys.full, fullOut);
        await uploadStreamFile(keys.preview, previewOut);

        const stems = await db.$queryRaw<StemRow[]>`
            SELECT id, "steamUrl", "trackIndex" FROM "Stem" WHERE "assetId" = ${assetId} ORDER BY "trackIndex"`;
        await inBatches(stems, STEM_CONCURRENCY, async (stem) => {
            const stemIn = path.join(dir, `stem-${stem.id}`);
            const stemOut = path.join(dir, `stem-${stem.id}.m4a`);
            await download(stem.steamUrl, stemIn);
            await ffmpeg(stemArgs(stemIn, stemOut));
            const key = keys.stem(stem.trackIndex);
            await uploadStreamFile(key, stemOut);
            await db.$executeRaw`UPDATE "Stem" SET "streamKey" = ${key} WHERE id = ${stem.id}`;
        });
        setProgress(job.id, 95);

        const seconds = Math.round(duration);
        const streamKey = hasFull ? keys.full : null;
        await db.$transaction([
            db.$executeRaw`UPDATE "Asset" SET "mediaStatus" = 'READY'::"MediaStatus", "streamKey" = ${streamKey},
                "previewKey" = ${keys.preview}, duration = ${seconds} WHERE id = ${assetId}`,
            db.$executeRaw`UPDATE "Song" SET duration = ${seconds} WHERE "assetId" = ${assetId}`,
        ]);
        addLog(job.id, { msg: `Asset ${assetId} ready (${seconds}s, ${stems.length} stems)`, level: "info" });
        return { assetId, duration: seconds, full: Boolean(streamKey), stems: stems.length };
    } catch (err) {
        logger.error(`[transcode] asset ${assetId} failed: ${err instanceof Error ? err.message : String(err)}`);
        await setStatus(assetId, "FAILED").catch(() => undefined);
        throw err;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
