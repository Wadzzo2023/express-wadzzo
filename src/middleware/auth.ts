// src/middleware/auth.ts
//
// Only the brand app's server may call this task server. Both share
// NEXTAUTH_SECRET; the brand app sends a key derived from it (never the secret
// itself) in the X-Task-Secret header, and anything else is rejected. The brand
// app has already checked the user and which brand they act for, so a request
// that passes here is trusted to carry the right creatorId.

import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

/** Must match taskServerKey in the brand app's src/lib/express/server-url.ts. */
export function taskServerKey(secret: string): string {
    return createHmac("sha256", secret).update("wadzzo-task-server").digest("hex");
}

const SECRET = process.env.NEXTAUTH_SECRET;
const KEY = SECRET ? taskServerKey(SECRET) : undefined;
const IS_PROD = process.env.NODE_ENV === "production";

if (!KEY) {
    logger.warn(
        IS_PROD
            ? "[auth] NEXTAUTH_SECRET is not set — every /jobs and /hotspots request will be rejected"
            : "[auth] NEXTAUTH_SECRET is not set — requests are NOT checked (development only)",
    );
}

function matches(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function requireTaskSecret(req: Request, res: Response, next: NextFunction): void {
    if (!KEY) {
        if (IS_PROD) {
            res.status(503).json({ error: "Task server is not configured" });
            return;
        }
        return next();
    }

    const given = req.headers["x-task-secret"];
    if (typeof given === "string" && matches(given, KEY)) return next();

    logger.warn(`[auth] Rejected ${req.method} ${req.originalUrl} from ${req.ip}`);
    res.status(401).json({ error: "Unauthorized" });
}
