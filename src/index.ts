// src/index.ts
import "dotenv/config";
import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { logger } from "./lib/logger.js";
import { authenticate } from "./middleware/auth.js";
import { pruneOldJobs } from "./lib/job-store.js";
import { hotspotScheduler } from "./lib/hotspot-scheduler.js";
import jobsRouter from "./routes/jobs.js";
import healthRouter from "./routes/health.js";
import hotspotsRouter from "./routes/hotspots.js";

const app: Express = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);
app.set("trust proxy", 1);

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
const helmetMw = helmet() as RequestHandler;

const corsMw = cors({
    origin: (process.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}) as RequestHandler;

const morganMw = morgan("combined", {
    stream: { write: (msg: string) => logger.http(msg.trim()) },
    skip: (req: express.Request) =>
        req.url === "/health" || req.url === "/health/ready",
}) as RequestHandler;

const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
    max: parseInt(process.env.RATE_LIMIT_MAX ?? "200", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down" },
}) as RequestHandler;
/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

app.use(helmetMw);
app.use(corsMw);
app.use(express.json());
app.use(morganMw);
app.use("/jobs", limiter);
app.use("/hotspots", limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/health", healthRouter);
app.use("/jobs", jobsRouter);
app.use("/hotspots", hotspotsRouter); // internal-only — no auth, creatorId comes from request body

// 404
app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use(
    (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
    ) => {
        logger.error("[express] Unhandled error:", err.message, err.stack);
        res.status(500).json({ error: "Internal server error" });
    }
);

// ── Background maintenance ────────────────────────────────────────────────────
setInterval(() => pruneOldJobs(), 30 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    logger.info(
        `✓ Task server running on port ${PORT} (${process.env.NODE_ENV ?? "development"})`
    );
    logger.info(`  Health:     http://localhost:${PORT}/health`);
    logger.info(`  Jobs API:   http://localhost:${PORT}/jobs`);
    logger.info(`  SSE:        http://localhost:${PORT}/jobs/:id/stream`);
    logger.info(`  Hotspots:   http://localhost:${PORT}/hotspots`);

    if (!process.env.NEXTAUTH_SECRET) {
        logger.warn("  NEXTAUTH_SECRET not set — authentication is disabled");
    }

    // ── Restore all active hotspot schedules from DB ────────────────────────
    // Must run after listen() so the event loop is ready for cron ticks.
    hotspotScheduler.restoreAll().catch((err: unknown) => {
        logger.error("[startup] Failed to restore hotspot schedules:", err);
    });
});

export default app;