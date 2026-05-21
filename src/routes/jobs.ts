// src/routes/jobs.ts
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
    createJob,
    getJob,
    listJobs,
    cancelJob,
} from "../lib/job-store.js";
import { sseSubscribe, sseClientCount } from "../lib/sse.js";
import { enqueueJob } from "../workers/dispatcher.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Validation schemas ───────────────────────────────────────────────────────

const EnqueueSchema = z.object({
    type: z.enum(["agent_run", "generic"]),
    creatorId: z.string().min(1),
    payload: z.record(z.unknown()),
    maxAttempts: z.number().int().min(1).max(5).optional(),
});

const ListQuerySchema = z.object({
    creatorId: z.string().optional(),
    type: z.enum(["agent_run", "generic"]).optional(),
    status: z.enum(["pending", "processing", "completed", "failed", "cancelled"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
});

// ─── POST /jobs/enqueue ───────────────────────────────────────────────────────
// Create and immediately dispatch a job. Returns { jobId } for polling.

router.post("/enqueue", (req: AuthenticatedRequest, res) => {
    const parse = EnqueueSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
        return;
    }

    const { type, creatorId, payload, maxAttempts } = parse.data;

    const job = createJob({ type, creatorId, payload, maxAttempts });

    // fire and forget — worker will update job status
    enqueueJob(job).catch((err) => {
        logger.error(`[routes/jobs] enqueueJob threw for ${job.id}:`, err);
    });

    logger.info(`[routes/jobs] Enqueued job ${job.id} type=${type} creator=${creatorId}`);
    res.status(202).json({ jobId: job.id });
});

// ─── GET /jobs/:id ────────────────────────────────────────────────────────────
// Poll job status + result.

router.get("/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    res.json(serializeJob(job));
});

// ─── GET /jobs ────────────────────────────────────────────────────────────────
// List jobs with optional filters.

router.get("/", (req: AuthenticatedRequest, res) => {
    const parse = ListQuerySchema.safeParse(req.query);
    if (!parse.success) {
        res.status(400).json({ error: "Invalid query params", details: parse.error.flatten() });
        return;
    }

    const { jobs, total } = listJobs(parse.data);
    res.json({
        jobs: jobs.map(serializeJob),
        total,
        limit: parse.data.limit ?? 50,
        offset: parse.data.offset ?? 0,
    });
});

// ─── POST /jobs/:id/cancel ────────────────────────────────────────────────────

router.post("/:id/cancel", (req: AuthenticatedRequest, res) => {
    const job = cancelJob(req.params.id);
    if (!job) {
        res.status(404).json({ error: "Job not found or cannot be cancelled" });
        return;
    }
    logger.info(`[routes/jobs] Cancelled job ${job.id}`);
    res.json({ ok: true, jobId: job.id, status: job.status });
});

// ─── GET /jobs/:id/stream ─────────────────────────────────────────────────────
// SSE endpoint — client receives live progress events without polling.
// Usage: const es = new EventSource(`/jobs/${jobId}/stream`)
//        es.onmessage = (e) => console.log(JSON.parse(e.data))

router.get("/:id/stream", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }

    // If job is already terminal, send a single event and close
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.write(`data: ${JSON.stringify({
            jobId: job.id,
            status: job.status,
            progress: job.progress ?? 100,
            result: job.result,
            error: job.error,
        })}\n\n`);
        res.end();
        return;
    }

    // Live subscription
    const cleanup = sseSubscribe(req.params.id, res);
    logger.debug(`[sse] Client connected to job ${req.params.id} (${sseClientCount(req.params.id)} total)`);

    req.on("close", () => {
        cleanup();
        logger.debug(`[sse] Client disconnected from job ${req.params.id}`);
    });
});

// ─── GET /jobs/:id/logs ───────────────────────────────────────────────────────
// Return all log entries for a job (useful for debugging).

router.get("/:id/logs", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    res.json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        progress: job.progress,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        log: job.log ?? [],
    });
});

// ─── Serializer ───────────────────────────────────────────────────────────────

function serializeJob(job: ReturnType<typeof getJob>) {
    if (!job) return null;
    return {
        jobId: job.id,
        type: job.type,
        status: job.status,
        creatorId: job.creatorId,
        progress: job.progress ?? 0,
        result: job.status === "completed" ? job.result : undefined,
        error: job.error,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
    };
}

export default router;