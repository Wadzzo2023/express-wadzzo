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
// Six sweeps a year -- 03:17 on the 1st of every other month.
//
// Sized so a *single failed run cannot lose data*. nft_oz keeps entries at
// `BUMP_TO` (175 days) and lifts them the moment they are written, so the
// binding number here is not one gap but two: at a ~62-day worst case, two
// consecutive gaps are 124 days and still fit inside 175. Miss one run and the
// next still arrives with ~51 days to spare.
//
// That matters because failure here is silent. A skipped cycle archives
// contract data -- restorable rather than lost, but it costs, and reads break
// until it is restored. Quarterly would have been cheaper (4 runs instead of
// 6, ~0.2 XLM a year) and still correct on paper, but a single missed run
// would have landed 9 days past expiry. The insurance is worth more than the
// difference. Still less than half the 13 runs a year this used to do.
//
// A day-of-month interval cannot express this: cron's day field tops out at
// 31, so `*/60` is not a valid two-month step. Stepping the *month* field is.

import cron from "node-cron";
import { logger } from "./logger.js";

const APP_URL = process.env.BANDFAN_APP_URL;
const SECRET = process.env.NEXTAUTH_SECRET;

const SCHEDULE = "17 3 1 */2 *"; // 03:17 on the 1st of every other month

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
    logger.info(`[keep-alive] Scheduled cron "${SCHEDULE}" (6x/year) → ${APP_URL}`);
}
