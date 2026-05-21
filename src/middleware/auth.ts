// src/middleware/auth.ts
//
// Verifies the Bearer token sent by clients.
// Strategy: sign a short-lived JWT with NEXTAUTH_SECRET on the client,
// verify it here. This way any service that knows the secret can call us.
//
// Alternative simple mode: accept a raw static API key in X-Api-Key header.

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger.js";

const SECRET = process.env.NEXTAUTH_SECRET;
if (!SECRET) {
    logger.warn("[auth] NEXTAUTH_SECRET is not set — all requests will be rejected");
}

export interface AuthenticatedRequest extends Request {
    authPayload?: {
        sub?: string;
        creatorId?: string;
        iat?: number;
        exp?: number;
    };
}

export function authenticate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
): void {
    // ── Option A: Bearer JWT ──────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        try {
            if (!SECRET) throw new Error("No secret configured");
            const payload = jwt.verify(token, SECRET) as AuthenticatedRequest["authPayload"];
            req.authPayload = payload;
            return next();
        } catch (err) {
            logger.debug("[auth] JWT verify failed:", err instanceof Error ? err.message : err);
        }
    }

    // ── Option B: static X-Api-Key header (same as NEXTAUTH_SECRET) ──────────
    const apiKey = req.headers["x-api-key"];
    if (apiKey && apiKey === SECRET) {
        req.authPayload = { sub: "static-key" };
        return next();
    }

    res.status(401).json({ error: "Unauthorized", hint: "Provide Authorization: Bearer <jwt> or X-Api-Key header" });
}