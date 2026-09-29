// src/routes/media.ts — media processing jobs (authenticated).
import { Router, type IRouter } from "express";
import { z } from "zod";

import { createJob } from "../lib/job-store.js";
import { logger } from "../lib/logger.js";
import { enqueueJob } from "../workers/dispatcher.js";

const router: IRouter = Router();

const TranscodeSchema = z.object({ assetId: z.number().int().positive() });

// POST /media/transcode — (re)build an asset's full + preview streams.
router.post("/transcode", (req, res) => {
    const parse = TranscodeSchema.safeParse(req.body);
    if (!parse.success) {
        res.status(400).json({ error: "Invalid request body", details: parse.error.flatten() });
        return;
    }
    const { assetId } = parse.data;
    const job = createJob({ type: "transcode_audio", creatorId: "system", payload: { assetId }, maxAttempts: 2 });
    enqueueJob(job).catch((err) => logger.error(`[routes/media] enqueueJob threw for ${job.id}:`, err));
    res.status(202).json({ jobId: job.id });
});

export default router;
