// src/index.ts
import "dotenv/config";
import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";

import { logger } from "./lib/logger.js";
import { authenticate } from "./middleware/auth.js";
import { pruneOldJobs } from "./lib/job-store.js";
import { hotspotScheduler } from "./lib/hotspot-scheduler.js";
import jobsRouter from "./routes/jobs.js";
import healthRouter from "./routes/health.js";
import hotspotsRouter from "./routes/hotspots.js";
import musicRouter, { handleMusicWebSocket } from "./routes/music.js";

const app: Express = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);
app.set("trust proxy", 1);

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
const helmetMw = helmet() as RequestHandler;

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const corsMw = cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
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
app.use(express.json({ limit: "50mb" }));
app.use(morganMw);
app.use("/jobs", limiter);
app.use("/hotspots", limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/health", healthRouter);
app.use("/jobs", jobsRouter);
app.use("/hotspots", hotspotsRouter); // internal-only — no auth, creatorId comes from request body
app.use("/music", limiter);
app.use("/music", musicRouter);

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

// ── Graceful error handling ───────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
    console.error("[process] Uncaught exception raw:", err);
    logger.error("[process] Uncaught exception:", err.message, err.stack);
});

process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error("[process] Unhandled rejection:", msg);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal: string) {
    logger.info(`[process] ${signal} received — shutting down gracefully`);
    server?.close(() => {
        logger.info("[process] Server closed");
        process.exit(0);
    });
    setTimeout(() => {
        logger.warn("[process] Forceful shutdown after 10s timeout");
        process.exit(1);
    }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Background maintenance ────────────────────────────────────────────────────
setInterval(() => pruneOldJobs(), 30 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    logger.info(
        `✓ Task server running on port ${PORT} (${process.env.NODE_ENV ?? "development"})`
    );
    logger.info(`  Health:     http://localhost:${PORT}/health`);
    logger.info(`  Jobs API:   http://localhost:${PORT}/jobs`);
    logger.info(`  SSE:        http://localhost:${PORT}/jobs/:id/stream`);
    logger.info(`  Hotspots:   http://localhost:${PORT}/hotspots`);
    logger.info(`  Music WS:   ws://localhost:${PORT}/music/stream`);

    if (!process.env.NEXTAUTH_SECRET) {
        logger.warn("  NEXTAUTH_SECRET not set — authentication is disabled");
    }

    // ── Restore all active hotspot schedules from DB ────────────────────────
    // Must run after listen() so the event loop is ready for cron ticks.
    hotspotScheduler.restoreAll().catch((err: unknown) => {
        logger.error("[startup] Failed to restore hotspot schedules:", err);
    });
});

// ── WebSocket for music streaming ────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    if (url.pathname === "/music/stream") {
        wss.handleUpgrade(request, socket, head, (ws) => {
            handleMusicWebSocket(ws);
        });
    } else {
        socket.destroy();
    }
});

export default app;