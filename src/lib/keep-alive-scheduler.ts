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
// Every 28 days, bounded by nft_oz's `BUMP_THRESHOLD` (30 days), not by how
// long entries live.
//
// `extend_ttl(threshold, extend_to)` only fires when remaining TTL is *below*
// threshold. So an entry sitting at `BUMP_TO` (120 days) is not renewable
// until it decays under 30 days remaining, and it expires 30 days after that:
// the usable window is exactly `BUMP_THRESHOLD` wide, whatever `BUMP_TO` is.
// A cadence at or above 30 days can therefore skip the window entirely and
// let data archive.
//
// Raising ownership from OpenZeppelin's hardcoded 30 days to 120 (see nft_oz's
// `extend_ownership_ttl`) does not widen that window and does not buy a slower
// cadence -- what it buys is slack. Ownership used to die 30 days after its
// last touch, so a single missed run left ~2 days of margin; now a run can be
// missed repeatedly without anything being archived. Widening the window would
// mean raising `BUMP_THRESHOLD` itself, which is a contract change.
//
// Most sweeps are legitimately no-ops as a result (hence `force: true` on the
// submission) -- they only do work once an entry has actually decayed.

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
