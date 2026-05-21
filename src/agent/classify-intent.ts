// src/agent/classify-intent.ts
// Direct port of ~/lib/agent/classify-intent.ts from your Next.js project.
// Replaces the db import with the local one — everything else is identical.

import { ChatOpenAI } from "@langchain/openai";
import { db } from "../lib/db.js";
import type { PinIntent } from "./types.js";

export type IntentType = "management" | "pin_drop" | "ambiguous";

export interface IntentClassification {
    intent: IntentType;
    confidence: number;
    reasoning: string;
    missingInfo: string | null;
    extractedSubject: string | null;
}

export interface DbPresenceCheck {
    found: boolean;
    count: number;
    sample: { id: string; title: string; startDate: Date | null; endDate: Date | null }[];
}

export type RoutingDecision =
    | { route: "management"; classification: IntentClassification }
    | { route: "pin_drop"; classification: IntentClassification }
    | { route: "clarify"; classification: IntentClassification; dbCheck: DbPresenceCheck | null; reason: "ambiguous" | "low_confidence" | "db_conflict" };

function stripJsonFences(text: string): string {
    return text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
}

function parseLooseJson<T>(raw: string): T | null {
    const clean = stripJsonFences(raw).trim();
    const start = clean.search(/[{[]/);
    if (start === -1) return null;
    const candidate = clean.slice(start);
    try { return JSON.parse(candidate) as T; } catch { /* continue */ }
    const repaired = candidate
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
    try { return JSON.parse(repaired) as T; } catch { return null; }
}

function extractTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return (content as unknown[])
            .map((b) => {
                if (typeof b === "string") return b;
                if (typeof b === "object" && b !== null) {
                    const r = b as Record<string, unknown>;
                    if (typeof r.text === "string") return r.text;
                }
                return "";
            })
            .join("");
    }
    return "";
}

export async function classifyIntent(
    messages: { role: string; text: string }[],
    priorIntent?: Partial<PinIntent> | null,
): Promise<IntentClassification> {
    const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
    const convo = messages.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join("\n");
    const priorContext = priorIntent?.query
        ? `Prior conversation was about: "${priorIntent.query}" in "${priorIntent.area ?? "unspecified area"}".`
        : "No prior conversation context.";

    const res = await llm.invoke([
        {
            role: "system",
            content: `You are an intent router for a location-based pin platform.

A CREATOR can do exactly two things:
1. MANAGEMENT — work with their OWN existing pins stored in the database.
   Includes: view, list, show, edit, update, rename, delete, hide, remove, archive,
   pause, resume, analyze, performance, stats, claim rate, redemption, collectors,
   who collected, best performing, worst performing, where should I drop.
   Signal words: "my", "mine", possessive language, past tense about own data.

2. PIN_DROP — find external real-world locations and create NEW pins from them.
   Includes: find, search, drop pins at, create pins for, all X in Y,
   locations of X, external brands (KFC, Starbucks), external categories
   (hospitals, restaurants, parks), art installations, UNESCO sites, events.

HARD RULES:
- "my pins / my hotspot / my analytics" → management, high confidence
- external brand/place + area, no possessive → pin_drop, high confidence
- "delete / hide / edit / pause / resume" → management, high confidence
- verb missing → ambiguous
- subject missing → ambiguous, missingInfo = "missing WHAT"

${priorContext}

Return ONLY valid JSON:
{"intent":"management"|"pin_drop"|"ambiguous","confidence":0.0,"reasoning":"one sentence","missingInfo":null,"extractedSubject":null}`,
        },
        { role: "user", content: `Classify:\n\n${convo}` },
    ]);

    const raw = extractTextContent(res.content);
    const parsed = parseLooseJson<IntentClassification>(raw);
    if (!parsed) {
        return { intent: "ambiguous", confidence: 0, reasoning: "Parse failed", missingInfo: null, extractedSubject: null };
    }
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0));
    parsed.extractedSubject = parsed.extractedSubject ?? null;
    parsed.missingInfo = parsed.missingInfo ?? null;
    return parsed;
}

export async function dbPresenceCheck(creatorId: string, subject: string): Promise<DbPresenceCheck> {
    if (!subject?.trim()) return { found: false, count: 0, sample: [] };
    try {
        const matches = await db.locationGroup.findMany({
            where: { creatorId, hidden: false, title: { contains: subject.trim(), mode: "insensitive" } },
            select: { id: true, title: true, startDate: true, endDate: true, hotspotId: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 10,
        });
        if (matches.length === 0) return { found: false, count: 0, sample: [] };

        const hotspotIds = [...new Set(matches.map((m) => m.hotspotId).filter(Boolean) as string[])];
        const templateIds = new Set<string>();
        if (hotspotIds.length > 0) {
            const hotspots = await db.hotspot.findMany({
                where: { id: { in: hotspotIds }, creatorId },
                select: { locationGroups: { orderBy: { createdAt: "asc" }, take: 1, select: { id: true } } },
            });
            for (const h of hotspots) { const tid = h.locationGroups[0]?.id; if (tid) templateIds.add(tid); }
        }

        const filtered = matches.filter((m) => !templateIds.has(m.id));
        return {
            found: filtered.length > 0,
            count: filtered.length,
            sample: filtered.slice(0, 5).map((m) => ({ id: m.id, title: m.title, startDate: m.startDate, endDate: m.endDate })),
        };
    } catch { return { found: false, count: 0, sample: [] }; }
}

// Answers the user can give to a db_conflict clarification question.
// When the last user message is one of these, we skip dbPresenceCheck and route directly.
const CLARIFICATION_ANSWERS: Record<string, "management" | "pin_drop"> = {
    "show my existing pins": "management",
    "find more & add to collection": "pin_drop",
    "search fresh — ignore existing": "pin_drop",
    "search fresh - ignore existing": "pin_drop",
    "find new locations & drop pins": "pin_drop",
    "show or manage my existing pins": "management",
};

export async function resolveRoute(
    messages: { role: string; text: string }[],
    creatorId: string,
    priorIntent?: Partial<PinIntent> | null,
): Promise<RoutingDecision> {

    // ── Check if the latest user message is a clarification answer ─────────────
    // If so, route directly without re-running dbPresenceCheck (which would
    // trigger the clarification question again).
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
        const normalized = lastUserMsg.text.trim().toLowerCase();
        const answeredRoute = CLARIFICATION_ANSWERS[normalized];
        if (answeredRoute) {
            const classification: IntentClassification = {
                intent: answeredRoute,
                confidence: 1.0,
                reasoning: "User answered clarification question directly",
                missingInfo: null,
                extractedSubject: priorIntent?.query ?? null,
            };
            return { route: answeredRoute, classification };
        }
    }

    const classification = await classifyIntent(messages, priorIntent);
    const { intent, confidence, extractedSubject } = classification;

    if (intent === "management" && confidence >= 0.85) return { route: "management", classification };

    if (intent === "pin_drop" && confidence >= 0.85) {
        if (extractedSubject) {
            const dbCheck = await dbPresenceCheck(creatorId, extractedSubject);
            if (dbCheck.found) return { route: "clarify", classification, dbCheck, reason: "db_conflict" };
        }
        return { route: "pin_drop", classification };
    }

    if (confidence >= 0.60 && confidence < 0.85) {
        let dbCheck: DbPresenceCheck | null = null;
        if (extractedSubject) {
            dbCheck = await dbPresenceCheck(creatorId, extractedSubject);
            if (dbCheck.found && intent === "pin_drop") return { route: "clarify", classification, dbCheck, reason: "db_conflict" };
            if (!dbCheck.found && intent === "pin_drop") return { route: "pin_drop", classification };
            if (intent === "management") return { route: "management", classification };
        }
        if (intent === "management") return { route: "management", classification };
        if (intent === "pin_drop") return { route: "pin_drop", classification };
    }

    let dbCheck: DbPresenceCheck | null = null;
    if (extractedSubject) dbCheck = await dbPresenceCheck(creatorId, extractedSubject);
    return { route: "clarify", classification, dbCheck, reason: intent === "ambiguous" ? "ambiguous" : "low_confidence" };
}

export function buildClarificationResponse(
    decision: Extract<RoutingDecision, { route: "clarify" }>,
): { type: "question"; message: string; fields: { id: string; label: string; inputType: string; options?: string[] }[] } {
    const { reason, classification, dbCheck } = decision;
    const subject = classification.extractedSubject;

    if (reason === "db_conflict" && dbCheck && subject) {
        return {
            type: "question",
            message: `I found ${dbCheck.count} pin${dbCheck.count !== 1 ? "s" : ""} matching "${subject}" in your account. What would you like to do?`,
            fields: [{
                id: "db_conflict_action", label: "Choose an action", inputType: "multiple_choice",
                options: ["Show my existing pins", "Find more & add to collection", "Search fresh — ignore existing"]
            }],
        };
    }
    if (!subject && classification.missingInfo?.toLowerCase().includes("what")) {
        return {
            type: "question", message: "What would you like to find or drop pins for?",
            fields: [{ id: "query", label: "What are you looking for?", inputType: "text" }]
        };
    }
    if (subject) {
        return {
            type: "question", message: `What would you like to do with "${subject}"?`,
            fields: [{
                id: "intent_choice", label: "Choose what you mean", inputType: "multiple_choice",
                options: ["Show or manage my existing pins", "Find new locations & drop pins"]
            }]
        };
    }
    return {
        type: "question", message: classification.missingInfo ?? "Could you clarify what you'd like to do?",
        fields: [{ id: "clarification", label: "What would you like to do?", inputType: "text" }]
    };
}