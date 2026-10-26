// src/types/index.ts

import type { AgentStep } from "../agent/contract";

export type JobType =
    | "agent_run"          // the map agent answering one message
    | "create_pins"        // carry out a confirmed bulk pin creation
    | "transcode_audio" // full + 30s preview AAC streams for an asset
    | "generic";           // extensible for future tasks

export type JobStatus =
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";

/** Job-type specific; each worker validates its own payload. */
export type JobPayload = Record<string, unknown>;

export interface Job {
    id: string;
    type: JobType;
    status: JobStatus;
    creatorId: string;
    payload: JobPayload;
    result?: unknown;
    error?: string;
    progress?: number;     // 0-100
    /** What the agent is doing, shown live in the chat (agent_run only). */
    steps?: AgentStep[];
    log?: LogEntry[];
    createdAt: Date;
    updatedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    attempts: number;
    maxAttempts: number;
}

export interface LogEntry {
    ts: string;            // ISO timestamp
    msg: string;
    level: "info" | "warn" | "error";
    data?: Record<string, unknown>;
}

export interface EnqueueRequest {
    type: JobType;
    creatorId: string;
    payload: JobPayload;
    maxAttempts?: number;
}

export interface JobListQuery {
    creatorId?: string;
    type?: JobType;
    status?: JobStatus;
    limit?: number;
    offset?: number;
}

// SSE event shapes
export interface SseProgressEvent {
    jobId: string;
    status: JobStatus;
    progress: number;
    log?: LogEntry;
    result?: unknown;
    error?: string;
}