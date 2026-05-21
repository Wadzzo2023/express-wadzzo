// src/agent/db.ts
// Single shared Prisma client for the entire task server.

import { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger.js";

declare global {
    // eslint-disable-next-line no-var
    var __prisma: PrismaClient | undefined;
}

export const db: PrismaClient =
    globalThis.__prisma ??
    new PrismaClient({
        log:
            process.env.NODE_ENV === "development"
                ? ["query", "warn", "error"]
                : ["warn", "error"],
    });

if (process.env.NODE_ENV !== "production") {
    globalThis.__prisma = db;
}

db.$connect()
    .then(() => logger.info("[db] Prisma connected"))
    .catch((err: unknown) => {
        logger.error("[db] Prisma connection failed:", err);
        process.exit(1);
    });