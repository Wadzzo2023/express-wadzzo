// src/types/index.ts

import { PinOptions } from "../agent/types";

export type JobType =
    | "agent_run"          // main agent pipeline (classify → run → store result)
    | "create_pins"   // ← add this
    | "generic";           // extensible for future tasks

export type JobStatus =
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";

export interface JobPayload {
    // agent_run
    messages?: { role: string; text: string }[];
    intent?: Record<string, unknown> | null;
    pinOptions?: PinOptions;
    creatorId?: string;
    pins?: unknown[];
    loadMore?: boolean;
    loadMoreOffset?: number;
    loadMoreType?: string;

    // create_pins
    jobId?: string;        // locationGroupJob id (only for create_pins)
    redeemMode?: string;

    // generic
    [key: string]: unknown;
}

export interface Job {
    id: string;
    type: JobType;
    status: JobStatus;
    creatorId: string;
    payload: JobPayload;
    result?: unknown;
    error?: string;
    progress?: number;     // 0-100
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