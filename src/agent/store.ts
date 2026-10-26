// src/agent/store.ts
//
// Reads a conversation's history for the model and saves the agent's answer.
// The only tables the task server writes for the agent: AgentMessage and
// AgentAction (proposals, which the Bandcoin app carries out after confirmation).

import type { Prisma } from "@prisma/client";
import { db } from "../lib/db";
import type { AgentBlock, ActionStatus } from "./contract";
import type { Run } from "./run";

const HISTORY_MESSAGES = 30;

export type HistoryTurn = { role: "user" | "assistant"; text: string };

/** The conversation's recent turns, as text the model can read, plus its earlier cards. */
export async function loadHistory(conversationId: string, creatorId: string) {
    const conversation = await db.agentConversation.findUnique({ where: { id: conversationId }, select: { creatorId: true } });
    if (!conversation || conversation.creatorId !== creatorId) throw new Error("Conversation not found for this brand");

    const [rows, actions] = await Promise.all([
        db.agentMessage.findMany({
            where: { conversationId },
            orderBy: { createdAt: "desc" },
            take: HISTORY_MESSAGES,
            select: { role: true, text: true, blocks: true },
        }),
        db.agentAction.findMany({ where: { conversationId }, select: { id: true, status: true, result: true } }),
    ]);
    const statusOf = new Map(actions.map((a) => [a.id, a]));

    const messages = rows.reverse();
    const turns: HistoryTurn[] = messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        text: m.role === "assistant" ? withCardNotes(m.text, asBlocks(m.blocks), statusOf) : m.text,
    }));
    const earlierBlocks = messages.filter((m) => m.role === "assistant").flatMap((m) => asBlocks(m.blocks));
    return { turns, earlierBlocks };
}

function asBlocks(json: Prisma.JsonValue): AgentBlock[] {
    return Array.isArray(json) ? (json as unknown as AgentBlock[]) : [];
}

/** "[card: …]" notes so the model remembers what it showed and what happened to proposals. */
function withCardNotes(text: string, blocks: AgentBlock[], actions: Map<string, { status: string; result: Prisma.JsonValue }>): string {
    const notes = blocks.map((b) => {
        switch (b.kind) {
            case "choices":
                return `[asked: "${b.question}" options: ${b.options.map((o) => o.label).join(" | ")}${b.answered ? ` → answered: ${b.answered.join(", ")}` : ""}]`;
            case "proposal": {
                const a = actions.get(b.actionId);
                const status = (a?.status ?? "pending") as ActionStatus;
                const outcome = a?.result && typeof a.result === "object" && "message" in a.result ? ` (${String((a.result as { message: unknown }).message)})` : "";
                return `[proposed ${b.action.type}: ${b.summary} → ${status}${outcome}]`;
            }
            case "report":
                return `[report ref=${b.id}: ${b.title}]`;
            case "collectors":
                return `[collectors ref=${b.id}: ${b.total} collectors shown]`;
            default:
                return `[${b.kind} ref=${b.id}: "${b.title}", ${b.items.length} items]`;
        }
    });
    return [text, ...notes].filter(Boolean).join("\n");
}

/** Saves the answer: its proposals first (so the cards can point at them), then the message. */
export async function saveAnswer(run: Run, text: string): Promise<string> {
    const proposalBlocks: AgentBlock[] = run.actions.map((a) => ({ kind: "proposal", id: a.id, actionId: a.id, action: a.action, summary: a.summary }));
    const blocks = [...run.blocks, ...proposalBlocks];

    const message = await db.$transaction(async (tx) => {
        if (run.actions.length > 0) {
            await tx.agentAction.createMany({
                data: run.actions.map((a) => ({
                    id: a.id,
                    conversationId: run.conversationId,
                    creatorId: run.brand.creatorId,
                    type: a.action.type,
                    payload: a.action as unknown as Prisma.InputJsonValue,
                })),
            });
        }
        const saved = await tx.agentMessage.create({
            data: {
                conversationId: run.conversationId,
                role: "assistant",
                text,
                blocks: blocks as unknown as Prisma.InputJsonValue,
                steps: run.steps as unknown as Prisma.InputJsonValue,
            },
            select: { id: true },
        });
        await tx.agentConversation.update({ where: { id: run.conversationId }, data: { updatedAt: new Date() } });
        return saved;
    });
    return message.id;
}
