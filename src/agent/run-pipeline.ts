
import { resolveRoute, buildClarificationResponse } from "./classify-intent.js";
import { logger } from "../lib/logger.js";
import type { AgentRunInput, AgentRunOutput, PinIntent, Pin, PinOptions, AgentMode, MessageRole } from "./types.js";
import { PinDropAgentInput, PinDropAgentOutput, runPinDropAgent } from "./pin-drop-agent.js";
import { CreatorAgentInput, runCreatorAgent } from "./pin-manage-agent";

interface AgentRunPayload {
    messages: { role: MessageRole; text: string }[];
    intent: Partial<PinIntent> | null;
    pinOptions: PinOptions | null;
    creatorId: string;
    pins?: Pin[];
    loadMore?: boolean;           // ← add
    loadMoreOffset?: number;      // ← add
    loadMoreType?: string;        // ← add
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export async function runAgentPipeline(input: AgentRunPayload): Promise<object> {
    const { messages, intent, pinOptions, creatorId, pins, loadMore, loadMoreOffset, loadMoreType } = input;

    logger.info(`[pipeline] Start — creator=${creatorId} loadMore=${loadMore ?? false}`);

    // Short-circuit: confirmed pins with pinOptions → skip routing, go straight to pin-drop
    if (pinOptions && pins && pins.length > 0) {
        logger.info(`[pipeline] Short-circuit — confirmed pins (${pins.length}) with pinOptions, skipping route classification`);
        const result = await runPinDropAgent({
            messages,
            intent,
            pinOptions,
            creatorId,
            pins,
        });
        return {
            reply: result.reply,
            stage: result.stage,
            intent: result.intent,
            pins: result.pins,
            pinOptions: result.pinOptions,
            jobId: result.jobId,
        };
    }

    // STEP 1: route
    const decision = await resolveRoute(messages, creatorId, intent);
    logger.info(`[pipeline] Route: ${decision.route}`);

    // STEP 2: dispatch
    if (decision.route === "management") {
        const result = await runCreatorAgent({
            messages,
            creatorId,
            priorIntent: intent,
            loadMore: loadMore ?? false,
            loadMoreOffset,
            loadMoreType,
        });
        return {
            reply: result.reply,
            stage: result.stage,
            intent: result.intent,
            mode: "management",
            pins: [],
        };
    }

    if (decision.route === "pin_drop") {
        console.log(`[decision.route: pin_drop] [runAgentPipeline] Running pin drop agent with intent: ${decision.classification.intent}`);
        const result = await runPinDropAgent({
            messages,
            intent,
            pinOptions,
            creatorId,
            pins,
        });

        return {
            reply: result.reply,
            stage: result.stage,
            intent: result.intent,
            pins: result.pins,
            pinOptions: result.pinOptions,
            jobId: result.jobId,
        };
    }

    // STEP 3: clarify
    const clarification = buildClarificationResponse(decision);
    const preservedIntent: PinIntent = {
        count: intent?.count ?? 0,
        countSpecified: intent?.countSpecified ?? false,
        query: intent?.query ?? decision.classification.extractedSubject ?? null,
        area: intent?.area ?? null,
        areaType: intent?.areaType ?? "unknown",
        confirmed: false,
        isNiche: intent?.isNiche ?? false,
        pinNumber: intent?.pinNumber ?? 1,
        ambiguousPinIntent: false,
    };

    return {
        reply: JSON.stringify(clarification),
        stage: "clarifying",
        intent: preservedIntent,
    };
}