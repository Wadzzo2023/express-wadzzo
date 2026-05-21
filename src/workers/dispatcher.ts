// src/workers/dispatcher.ts

import type { Job } from "../types/index.js";
import { markProcessing, markCompleted, markFailed, addLog, getJob } from "../lib/job-store.js";
import { logger } from "../lib/logger.js";
import { runAgentJob } from "./agent-worker.js";
import { runCreatePinsJob } from "./create-pins-worker.js";
const MAX_CONCURRENT = parseInt(process.env.WORKER_CONCURRENCY ?? "5", 10);
let running = 0;
const queue: (() => void)[] = [];

function acquireSlot(): Promise<void> {
    return new Promise((resolve) => {
        if (running < MAX_CONCURRENT) { running++; resolve(); }
        else queue.push(() => { running++; resolve(); });
    });
}

function releaseSlot(): void {
    running--;
    const next = queue.shift();
    if (next) next();
}

export async function enqueueJob(job: Job): Promise<void> {
    await acquireSlot();
    const timeout = parseInt(process.env.JOB_TIMEOUT_MS ?? "120000", 10);

    try {
        const j = markProcessing(job.id);
        if (!j) { releaseSlot(); return; }

        logger.info(`[dispatcher] Starting job ${job.id} type=${job.type} attempt=${j.attempts}`);
        addLog(job.id, { msg: `Job started (attempt ${j.attempts})`, level: "info" });

        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Job timed out after ${timeout}ms`)), timeout),
        );

        let result: unknown;
        switch (job.type) {
            case "agent_run":
                result = await Promise.race([runAgentJob(job), timeoutPromise]);
                break;
            case "create_pins":
                result = await Promise.race([runCreatePinsJob(job), timeoutPromise]);
                break;
            case "generic":
                result = { ok: true };
                break;
            default:
                throw new Error(`Unknown job type`);
        }

        markCompleted(job.id, result);
        addLog(job.id, { msg: "Job completed successfully", level: "info" });

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[dispatcher] Job ${job.id} failed: ${msg}`);
        addLog(job.id, { msg: `Job failed: ${msg}`, level: "error" });

        const current = getJob(job.id);
        const attempts = current?.attempts ?? job.attempts ?? 1;
        const maxAttempts = current?.maxAttempts ?? job.maxAttempts ?? 3;

        if (attempts < maxAttempts) {
            const delay = Math.pow(2, attempts) * 1000;
            logger.info(`[dispatcher] Retrying job ${job.id} in ${delay}ms (${attempts}/${maxAttempts})`);
            addLog(job.id, { msg: `Retrying in ${delay}ms (attempt ${attempts}/${maxAttempts})`, level: "warn" });
            setTimeout(() => void enqueueJob(job), delay);
        } else {
            markFailed(job.id, msg);
        }
    } finally {
        releaseSlot();
    }
}