// src/lib/sse.ts
// Server-Sent Events broadcaster.
// Clients call GET /jobs/:id/stream — they get live job progress
// without polling.

import type { Response } from "express";
import type { SseProgressEvent } from "../types/index.js";

type SseClient = {
    res: Response;
    jobId: string;
};

const clients = new Map<string, Set<SseClient>>();

export function sseSubscribe(jobId: string, res: Response): () => void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx: disable buffering
    res.flushHeaders();

    const client: SseClient = { res, jobId };
    if (!clients.has(jobId)) clients.set(jobId, new Set());
    clients.get(jobId)!.add(client);

    // heartbeat every 15s to keep the connection alive through proxies
    const hb = setInterval(() => {
        res.write(": heartbeat\n\n");
    }, 15_000);

    // cleanup on disconnect
    const cleanup = () => {
        clearInterval(hb);
        clients.get(jobId)?.delete(client);
        if (clients.get(jobId)?.size === 0) clients.delete(jobId);
    };

    res.on("close", cleanup);
    return cleanup;
}

export function sseBroadcast(jobId: string, event: SseProgressEvent): void {
    const bucket = clients.get(jobId);
    if (!bucket || bucket.size === 0) return;

    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of bucket) {
        try {
            client.res.write(data);
        } catch {
            bucket.delete(client);
        }
    }
}

export function sseClientCount(jobId: string): number {
    return clients.get(jobId)?.size ?? 0;
}