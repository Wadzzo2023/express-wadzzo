// src/agent/agent.ts
//
// One run of the map agent: read the conversation, let the model call tools
// (each shown live as a progress step) until it answers or asks a question,
// then save the answer with its cards and proposals.

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { logger } from "../lib/logger";
import type { AgentBlock, AgentRunPayload, AgentRunResult } from "./contract";
import { loadBrandContext } from "./context";
import { AGENT_MODEL } from "./model";
import { systemPrompt } from "./prompt";
import { Run, type ResultSet } from "./run";
import { loadHistory, saveAnswer } from "./store";
import { AGENT_TOOLS } from "./tools";
import { toLangChain } from "./tools/define";

/** Model ↔ tool round trips per message. Plenty for search → show → propose chains. */
const MAX_ROUNDS = 10;

const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

function textOf(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : ((b as { text?: string }).text ?? ""))).join("").trim();
    return "";
}

/** Earlier cards become result sets again, so "pin those parks" works on the next message. */
function restoreResults(run: Run, blocks: AgentBlock[]) {
    for (const b of blocks) {
        let set: ResultSet | null = null;
        switch (b.kind) {
            case "places":
                set = { kind: "places", title: b.title, items: b.items, area: b.area };
                break;
            case "pins":
            case "hotspots":
                set = { kind: b.kind, title: b.title, items: b.items } as ResultSet;
                break;
        }
        if (set) run.results.set(b.id, set);
    }
}

export function validatePayload(p: unknown): AgentRunPayload {
    const o = p as Partial<AgentRunPayload> | null;
    if (!o || typeof o.conversationId !== "string" || typeof o.creatorId !== "string") {
        throw new Error("agent_run payload needs conversationId and creatorId");
    }
    return { conversationId: o.conversationId, creatorId: o.creatorId, timeZone: validZone(o.timeZone) };
}

function validZone(tz: unknown): string | undefined {
    if (typeof tz !== "string" || tz.length > 60) return undefined;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return tz;
    } catch {
        return undefined;
    }
}

export async function runAgent(jobId: string, payload: AgentRunPayload): Promise<AgentRunResult> {
    const brand = await loadBrandContext(payload.creatorId);
    const run = new Run(jobId, brand, payload.conversationId);
    const reading = run.step("Understanding your request…");

    const { turns, earlierBlocks } = await loadHistory(payload.conversationId, payload.creatorId);
    restoreResults(run, earlierBlocks);

    const messages: BaseMessage[] = [
        new SystemMessage(systemPrompt(brand, payload.timeZone)),
        ...turns.map((t) => (t.role === "user" ? new HumanMessage(t.text) : new AIMessage(t.text))),
    ];
    const model = new ChatOpenAI({ model: AGENT_MODEL, maxTokens: 4000 }).bindTools(AGENT_TOOLS.map(toLangChain));

    let answer = "";
    try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
            const reply = await model.invoke(messages);
            if (round === 0) reading.done();
            messages.push(reply);

            const calls = reply.tool_calls ?? [];
            if (calls.length === 0) {
                answer = textOf(reply.content);
                break;
            }

            for (const call of calls) {
                messages.push(new ToolMessage({ tool_call_id: call.id ?? "", content: await callTool(run, call.name, call.args) }));
            }

            if (run.asked) {
                answer = textOf(reply.content);
                break;
            }
            if (round === MAX_ROUNDS - 1) {
                // Out of rounds: ask for a final answer without more tool calls.
                messages.push(new HumanMessage("(System: no more tool calls. Answer now with what you have.)"));
                answer = textOf((await new ChatOpenAI({ model: AGENT_MODEL, maxTokens: 1000 }).invoke(messages)).content);
            }
        }
    } catch (err) {
        logger.error(`[agent] job=${jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
        reading.done();
        run.step("Something went wrong").fail();
        answer = "Sorry — something went wrong on my side while working on that. Please try again.";
    }

    if (!answer) answer = run.asked ? "" : run.blocks.length || run.actions.length ? "Here's what I found." : "Done.";
    const messageId = await saveAnswer(run, answer);
    return { messageId };
}

/**
 * Runs one tool call with a visible progress step. Errors go back to the model
 * as text it can act on; the person only sees that the step didn't finish.
 */
async function callTool(run: Run, name: string, rawArgs: unknown): Promise<string> {
    const tool = byName.get(name);
    if (!tool) return JSON.stringify({ error: `No tool named ${name}.` });

    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
        return JSON.stringify({ error: "Invalid arguments", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }

    const step = tool.quiet ? null : run.step(tool.label(parsed.data, run));
    try {
        const out = await tool.run(parsed.data, run);
        step?.done(out.detail);
        return JSON.stringify(out.model);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[agent] tool ${name} failed: ${message}`);
        step?.fail("Couldn't finish this step");
        return JSON.stringify({ error: message });
    }
}
