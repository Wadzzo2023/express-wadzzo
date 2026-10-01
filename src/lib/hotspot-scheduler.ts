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

import cron from "node-cron";
import cronParser from "cron-parser";
import { db } from "./db";
import { logger } from "./logger";
import { dropPinsForHotspot, isPendingFirstDrop } from "./hotspot-drop";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduledHotspot {
    hotspotId: string;
    creatorId: string;
    dropEveryDays: number;
    task: ReturnType<typeof cron.schedule>;
    anchorDate: Date;
    /** When the hotspot starts later: release the first drop exactly then. */
    firstDropAt?: Date;
    firstDropTimer?: ReturnType<typeof setTimeout>;
}

/** setTimeout can't wait longer than ~24.8 days; longer waits re-arm in steps. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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
    start(hotspotId: string, creatorId: string, dropEveryDays: number, anchorDate: Date = new Date(), firstDropAt?: Date): void {
        this.stop(hotspotId); // idempotent — clear any stale task

        const expression = buildCronExpression(dropEveryDays, anchorDate);
        logger.info(
            `[hotspot-scheduler] Starting hotspot=${hotspotId} cron="${expression}" (every ${dropEveryDays}d)`
        );

        const task = cron.schedule(expression, () => {
            void this.runDrop(hotspotId);
        });

        const entry: ScheduledHotspot = { hotspotId, creatorId, dropEveryDays, task, anchorDate, firstDropAt };
        this.schedules.set(hotspotId, entry);
        this.armFirstDrop(entry);
    }

    /** One-off timer for the first drop (cron's "every N days" may not land on the start date). */
    private armFirstDrop(entry: ScheduledHotspot): void {
        if (entry.firstDropTimer) clearTimeout(entry.firstDropTimer);
        entry.firstDropTimer = undefined;
        if (!entry.firstDropAt) return;
        const wait = entry.firstDropAt.getTime() - Date.now();
        if (wait <= 0) {
            entry.firstDropAt = undefined;
            void this.runDrop(entry.hotspotId);
            return;
        }
        entry.firstDropTimer = setTimeout(() => {
            if (wait > MAX_TIMEOUT_MS) this.armFirstDrop(entry);
            else {
                entry.firstDropAt = undefined;
                entry.firstDropTimer = undefined;
                void this.runDrop(entry.hotspotId);
            }
        }, Math.min(wait, MAX_TIMEOUT_MS));
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
        if (entry.firstDropTimer) clearTimeout(entry.firstDropTimer);
        entry.firstDropTimer = undefined;
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
        this.armFirstDrop(entry); // still waiting for the start date? re-arm (or drop now if it passed)
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
        if (entry.firstDropTimer) clearTimeout(entry.firstDropTimer);
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
        return cronParser.parse(expression).next().toDate();
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
                hotspotStartDate: true,
                hotspotEndDate: true,
                createdAt: true,
                locationGroups: { where: { hidden: true }, select: { hidden: true, startDate: true, createdAt: true } },
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

            // Drops repeat from the start (or creation, whichever is later). A first
            // drop still waiting to be released is re-armed — or released now if
            // its time passed while the server was down.
            const anchor = h.hotspotStartDate > h.createdAt ? h.hotspotStartDate : h.createdAt;
            const pending = h.locationGroups.some(isPendingFirstDrop);
            this.start(h.id, h.creatorId, h.dropEveryDays, anchor, pending ? h.hotspotStartDate : undefined);
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
// Import this anywhere: `import { hotspotScheduler } from "../lib/hotspot-scheduler"`

export const hotspotScheduler = new HotspotScheduler();