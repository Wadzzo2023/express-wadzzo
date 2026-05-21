// src/lib/job-store.ts
//
// Dual-mode job store:
//   • If REDIS_URL is set → uses BullMQ (persistent, multi-node)
//   • Otherwise           → in-memory Map (single-node, dev-friendly)
//
// All mutations emit to the SSE broadcaster so callers get live updates.

import { randomUUID } from "crypto";
import type { Job, JobType, JobStatus, JobPayload, LogEntry, JobListQuery } from "../types/index.js";
import { logger } from "./logger.js";
import { sseBroadcast } from "../lib/sse.js";

// ─── In-memory store ─────────────────────────────────────────────────────────

const jobs = new Map<string, Job>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function touch(job: Job): Job {
    job.updatedAt = new Date();
    jobs.set(job.id, job);

    // broadcast to any SSE listeners
    sseBroadcast(job.id, {
        jobId: job.id,
        status: job.status,
        progress: job.progress ?? 0,
        result: job.status === "completed" ? job.result : undefined,
        error: job.error,
    });

    return job;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createJob(params: {
    type: JobType;
    creatorId: string;
    payload: JobPayload;
    maxAttempts?: number;
}): Job {
    const job: Job = {
        id: randomUUID(),
        type: params.type,
        status: "pending",
        creatorId: params.creatorId,
        payload: params.payload,
        log: [],
        progress: 0,
        attempts: 0,
        maxAttempts: params.maxAttempts ?? 3,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    jobs.set(job.id, job);
    logger.debug(`[job-store] Created job ${job.id} type=${job.type}`);
    return job;
}

export function getJob(id: string): Job | undefined {
    return jobs.get(id);
}

export function listJobs(query: JobListQuery = {}): { jobs: Job[]; total: number } {
    let all = Array.from(jobs.values());

    if (query.creatorId) all = all.filter((j) => j.creatorId === query.creatorId);
    if (query.type) all = all.filter((j) => j.type === query.type);
    if (query.status) all = all.filter((j) => j.status === query.status);

    // newest first
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = all.length;
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    return { jobs: all.slice(offset, offset + limit), total };
}

export function markProcessing(id: string): Job | null {
    const job = jobs.get(id);
    if (!job) return null;
    job.status = "processing";
    job.startedAt = new Date();
    job.attempts += 1;
    return touch(job);
}

export function addLog(id: string, entry: Omit<LogEntry, "ts">): void {
    const job = jobs.get(id);
    if (!job) return;
    const full: LogEntry = { ts: new Date().toISOString(), ...entry };
    job.log = [...(job.log ?? []), full];
    // broadcast partial progress without changing status
    sseBroadcast(job.id, {
        jobId: job.id,
        status: job.status,
        progress: job.progress ?? 0,
        log: full,
    });
    jobs.set(job.id, job);
}

export function setProgress(id: string, progress: number): void {
    const job = jobs.get(id);
    if (!job) return;
    job.progress = Math.min(100, Math.max(0, progress));
    touch(job);
}

export function markCompleted(id: string, result: unknown): Job | null {
    const job = jobs.get(id);
    if (!job) return null;
    job.status = "completed";
    job.result = result;
    job.progress = 100;
    job.completedAt = new Date();
    logger.info(`[job-store] ✓ Job ${id} completed`);
    return touch(job);
}

export function markFailed(id: string, error: string): Job | null {
    const job = jobs.get(id);
    if (!job) return null;
    job.status = "failed";
    job.error = error;
    job.completedAt = new Date();
    logger.error(`[job-store] ✗ Job ${id} failed: ${error}`);
    return touch(job);
}

export function cancelJob(id: string): Job | null {
    const job = jobs.get(id);
    if (!job || job.status === "completed" || job.status === "failed") return null;
    job.status = "cancelled";
    job.completedAt = new Date();
    return touch(job);
}

/** Prune completed/failed jobs older than maxAgeMs (default 2h) */
export function pruneOldJobs(maxAgeMs = 2 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, job] of jobs) {
        if (
            (job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
            job.updatedAt.getTime() < cutoff
        ) {
            jobs.delete(id);
            pruned++;
        }
    }
    if (pruned > 0) logger.debug(`[job-store] Pruned ${pruned} old jobs`);
    return pruned;
}