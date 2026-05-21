// src/workers/agent-worker.ts
// Runs the full agent pipeline directly — no HTTP call, no Next.js, no QStash.

import type { Job } from "../types/index.js";
import { addLog, setProgress } from "../lib/job-store.js";
import { runAgentPipeline } from "../agent/run-pipeline.js";
import type { AgentRunInput } from "../agent/types.js";
import { logger } from "../lib/logger.js";

export async function runAgentJob(job: Job): Promise<unknown> {
    const payload = job.payload as AgentRunInput;

    if (!payload.creatorId) throw new Error("Missing creatorId in job payload");
    if (!payload.messages?.length) throw new Error("Missing messages in job payload");

    addLog(job.id, { msg: `Running agent pipeline for creator ${payload.creatorId}`, level: "info" });
    setProgress(job.id, 10);

    logger.debug(`[agent-worker] job=${job.id} loadMore=${payload.loadMore ?? false} type=${payload.loadMoreType ?? "none"}`);

    const result = await runAgentPipeline(payload);

    setProgress(job.id, 100);
    addLog(job.id, { msg: `Pipeline done — stage=${result.stage} mode=${result.mode ?? "pin_drop"}`, level: "info", });

    return result;
}