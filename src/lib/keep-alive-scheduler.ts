// src/lib/keep-alive-scheduler.ts
//
// Calls the main app's `/api/internal/keep-alive` endpoint on a fixed
// schedule so nft_oz's contract instance, editions, and minted tokens never
// actually reach Soroban's TTL/state-archival expiry. The actual on-chain
// work (DB query, signing with the treasury key, submitting the
// `keep_alive` call) happens in the main Next.js app, not here — this
// service only owns the clock, same "cron here, work there" shape as
// everything else this task server schedules.
//
// Every 28 days: comfortably inside OpenZeppelin's own 30-day
// ownership-data TTL window (see nft_oz's `keep_alive` doc comment), so a
// token's ownership data never actually goes stale between runs, with a
// couple of days' margin for a run that gets delayed or briefly fails.

import cron from "node-cron";
import { logger } from "./logger.js";

const APP_URL = process.env.BANDFAN_APP_URL;
const SECRET = process.env.NEXTAUTH_SECRET;

const SCHEDULE = "17 3 */28 * *"; // 03:17, every 28 days

async function runKeepAlive(): Promise<void> {
    if (!SECRET) {
        logger.warn("[keep-alive] NEXTAUTH_SECRET not set — skipping run");
        return;
    }

    logger.info("[keep-alive] Starting scheduled run");
    try {
        const res = await fetch(`${APP_URL}/api/internal/keep-alive`, {
            method: "POST",
            headers: { "x-api-key": SECRET },
        });
        const body: unknown = await res.json().catch(() => undefined);

        if (!res.ok) {
            logger.error(`[keep-alive] Run failed (${res.status})`, body);
            return;
        }
        logger.info("[keep-alive] Run complete", body);
    } catch (err) {
        logger.error(
            "[keep-alive] Run threw:",
            err instanceof Error ? err.message : String(err)
        );
    }
}

/** Registers the cron. Call once at boot, same as `hotspotScheduler`. */
export function startKeepAliveScheduler(): void {
    cron.schedule(SCHEDULE, () => {
        void runKeepAlive();
    });
    logger.info(`[keep-alive] Scheduled cron "${SCHEDULE}" (every 28 days) → ${APP_URL}`);
}
