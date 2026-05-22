// src/routes/health.ts
import { Router, type IRouter } from "express";
import { listJobs } from "../lib/job-store.js";
import { hotspotScheduler } from "../lib/hotspot-scheduler.js";

const router: IRouter = Router();

// GET /health — uptime check (no auth)
router.get("/", (_req, res) => {
    const { jobs } = listJobs({ limit: 1000 });
    const counts = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
    };
    for (const j of jobs) counts[j.status]++;

    res.json({
        ok: true,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        jobs: counts,
        hotspotSchedules: hotspotScheduler.count(),
        timestamp: new Date().toISOString(),
    });
});

// GET /health/ready — k8s readiness probe
router.get("/ready", (_req, res) => {
    res.json({ ok: true });
});

export default router;