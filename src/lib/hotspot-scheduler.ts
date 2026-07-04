/**
 * src/lib/hotspot-scheduler.ts
 *
 * Node-cron based hotspot drop scheduler.
 * Replaces QStash. One cron task per active hotspot, stored in-memory.
 * On server boot, call `hotspotScheduler.restoreAll()` to rebuild from DB.
 *
 * Responsibilities:
 *  - Start  : register a cron that calls dropPinsForHotspot() on interval
 *  - Pause  : stop the cron task (task kept in map, isActive=false in DB)
 *  - Resume : restart the cron task (isActive=true in DB)
 *  - Delete : stop + remove from map + mark isActive=false in DB
 *  - Restore: on boot, reload all isActive=true hotspots from DB
 */

import cron, { type ScheduledTask } from "node-cron";
import cronParser from "cron-parser";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { dropPinsForHotspot } from "./hotspot-drop";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduledHotspot {
    hotspotId: string;
    creatorId: string;
    dropEveryDays: number;
    task: ScheduledTask;
    anchorDate: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


function buildCronExpression(dropEveryDays: number, anchorDate: Date = new Date()): string {
    const m = anchorDate.getMinutes();
    const h = anchorDate.getHours();
    const mm = String(m).padStart(2, "0");
    const hh = String(h).padStart(2, "0");
    if (dropEveryDays === 1) return `${mm} ${hh} * * *`;
    if (dropEveryDays <= 28) return `${mm} ${hh} */${dropEveryDays} * *`;
    return `${mm} ${hh} 1 * *`; // monthly fallback
}

// ─── Scheduler class ──────────────────────────────────────────────────────────

class HotspotScheduler {
    /** Map of hotspotId → scheduled task metadata */
    private readonly schedules = new Map<string, ScheduledHotspot>();

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Register and immediately start a cron for this hotspot.
     * Safe to call multiple times — stops any existing task first.
     */
    start(hotspotId: string, creatorId: string, dropEveryDays: number, anchorDate: Date = new Date()): void {
        this.stop(hotspotId); // idempotent — clear any stale task

        const expression = buildCronExpression(dropEveryDays, anchorDate);
        logger.info(
            `[hotspot-scheduler] Starting hotspot=${hotspotId} cron="${expression}" (every ${dropEveryDays}d)`
        );

        const task = cron.schedule(expression, () => {
            void this.runDrop(hotspotId);
        });

        this.schedules.set(hotspotId, { hotspotId, creatorId, dropEveryDays, task, anchorDate });
    }

    /**
     * Pause: stop firing the cron. Task stays in map so it can be resumed.
     * Caller is responsible for setting isActive=false in DB.
     */
    pause(hotspotId: string): boolean {
        const entry = this.schedules.get(hotspotId);
        if (!entry) {
            logger.warn(`[hotspot-scheduler] pause — no task found for hotspot=${hotspotId}`);
            return false;
        }
        entry.task.stop();
        logger.info(`[hotspot-scheduler] Paused hotspot=${hotspotId}`);
        return true;
    }

    /**
     * Resume: restart a previously paused cron.
     * Caller is responsible for setting isActive=true in DB.
     */
    resume(hotspotId: string): boolean {
        const entry = this.schedules.get(hotspotId);
        if (!entry) {
            logger.warn(`[hotspot-scheduler] resume — no task found for hotspot=${hotspotId}`);
            return false;
        }
        entry.task.start();
        logger.info(`[hotspot-scheduler] Resumed hotspot=${hotspotId}`);
        return true;
    }

    /**
     * Delete: stop cron and remove from map entirely.
     * Caller is responsible for updating DB (isActive=false, hide groups, etc.).
     */
    stop(hotspotId: string): void {
        const entry = this.schedules.get(hotspotId);
        if (!entry) return;
        entry.task.stop();
        this.schedules.delete(hotspotId);
        logger.info(`[hotspot-scheduler] Deleted schedule for hotspot=${hotspotId}`);
    }

    /** Is there a registered (not necessarily running) task for this hotspot? */
    has(hotspotId: string): boolean {
        return this.schedules.has(hotspotId);
    }

    /**
     * Return the next scheduled run time for a hotspot, or null if not scheduled.
     */
    getNextRunTime(hotspotId: string): Date | null {
        const entry = this.schedules.get(hotspotId);
        if (!entry) return null;
        const expression = buildCronExpression(entry.dropEveryDays, entry.anchorDate);
        return cronParser.parseExpression(expression).next().toDate();
    }

    /** Count of currently tracked schedules (for health endpoint). */
    count(): number {
        return this.schedules.size;
    }

    /**
     * Restore all active hotspots from DB on server boot.
     * Call once inside `app.listen` callback.
     */
    async restoreAll(): Promise<void> {
        logger.info("[hotspot-scheduler] Restoring active hotspot schedules from DB…");

        const activeHotspots = await db.hotspot.findMany({
            where: { isActive: true, hidden: false },
            select: {
                id: true,
                creatorId: true,
                dropEveryDays: true,
                hotspotEndDate: true,
                createdAt: true,
            },
        });

        let restored = 0;
        const now = new Date();

        for (const h of activeHotspots) {
            // Skip if end date has already passed — let the next drop attempt clean it up
            if (h.hotspotEndDate < now) {
                logger.info(
                    `[hotspot-scheduler] Skipping expired hotspot=${h.id} (endDate=${h.hotspotEndDate.toISOString()})`
                );
                // Mark as inactive so we don't reload it again
                await db.hotspot.update({ where: { id: h.id }, data: { isActive: false } });
                continue;
            }

            this.start(h.id, h.creatorId, h.dropEveryDays, h.createdAt);
            restored++;
        }

        logger.info(
            `[hotspot-scheduler] Restored ${restored} / ${activeHotspots.length} hotspot schedules`
        );
    }

    // ── Private ────────────────────────────────────────────────────────────────

    private async runDrop(hotspotId: string): Promise<void> {
        logger.info(`[hotspot-scheduler] Triggering drop for hotspot=${hotspotId}`);
        try {
            const result = await dropPinsForHotspot(db, hotspotId);

            if ("expired" in result && result.expired) {
                // Hotspot expired — clean up schedule
                logger.info(`[hotspot-scheduler] Hotspot=${hotspotId} expired, removing schedule`);
                this.stop(hotspotId);
                return;
            }

            if ("skipped" in result && result.skipped) {
                logger.warn(`[hotspot-scheduler] Drop skipped for hotspot=${hotspotId}`, result);
                return;
            }

            logger.info(
                `[hotspot-scheduler] Drop complete hotspot=${hotspotId}`,
                result
            );
        } catch (err) {
            logger.error(
                `[hotspot-scheduler] Drop failed for hotspot=${hotspotId}:`,
                err instanceof Error ? err.message : String(err)
            );
        }
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
// Import this anywhere: `import { hotspotScheduler } from "../lib/hotspot-scheduler.js"`

export const hotspotScheduler = new HotspotScheduler();