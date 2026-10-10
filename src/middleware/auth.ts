// src/middleware/auth.ts
//
// Only the brand app's server may call this task server. It sends the shared
// TASK_SERVER_SECRET in the X-Task-Secret header; anything else is rejected.
// The brand app has already checked the user and which brand they act for, so
// a request that passes here is trusted to carry the right creatorId.

import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

const SECRET = process.env.TASK_SERVER_SECRET;
const IS_PROD = process.env.NODE_ENV === "production";

if (!SECRET) {
    logger.warn(
        IS_PROD
            ? "[auth] TASK_SERVER_SECRET is not set — every /jobs and /hotspots request will be rejected"
            : "[auth] TASK_SERVER_SECRET is not set — requests are NOT checked (development only)",
    );
}

function matches(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function requireTaskSecret(req: Request, res: Response, next: NextFunction): void {
    if (!SECRET) {
        if (IS_PROD) {
            res.status(503).json({ error: "Task server is not configured" });
            return;
        }
        return next();
    }

    const given = req.headers["x-task-secret"];
    if (typeof given === "string" && matches(given, SECRET)) return next();

    logger.warn(`[auth] Rejected ${req.method} ${req.originalUrl} from ${req.ip}`);
    res.status(401).json({ error: "Unauthorized" });
}
