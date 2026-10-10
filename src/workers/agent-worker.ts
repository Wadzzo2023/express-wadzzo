// src/workers/agent-worker.ts — runs the map agent for one message (see src/agent/agent.ts).

import type { Job } from "../types/index";
import { runAgent, validatePayload } from "../agent/agent";

export async function runAgentJob(job: Job): Promise<unknown> {
    const payload = validatePayload(job.payload);
    // The job's owner and the payload must agree; the brand app sets both.
    if (payload.creatorId !== job.creatorId) throw new Error("agent_run payload is for a different brand than the job");
    return runAgent(job.id, payload);
}
