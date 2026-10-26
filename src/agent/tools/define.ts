// src/agent/tools/define.ts
//
// One shape for every agent tool. `label` is what the person sees while it runs
// ("Searching parks in Clinton County…"); `run` returns what the model reads and
// an optional outcome for the progress line ("Found 12 places").
//
// Tools never receive a brand id from the model: they act for `run.brand`.

import { tool } from "@langchain/core/tools";
import type { z } from "zod";
import type { Run } from "../run";

export type ToolOutput = { model: unknown; detail?: string };

export type AgentTool<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
    name: string;
    description: string;
    schema: S;
    label: (args: z.infer<S>, run: Run) => string;
    run: (args: z.infer<S>, run: Run) => Promise<ToolOutput>;
    /** Shown no progress line (cheap, UI-only tools). */
    quiet?: boolean;
};

export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(t: AgentTool<S>): AgentTool {
    return t as unknown as AgentTool;
}

/** The LangChain shape `bindTools` needs. We call `run` ourselves, so `func` is never used. */
export function toLangChain(t: AgentTool) {
    return tool(async () => "", { name: t.name, description: t.description, schema: t.schema });
}

/** "1 place" / "3 places". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Parses a date the model wrote ("2026-11-01" or ISO). Throws a message the model can act on. */
export function parseDate(value: string, field: string): Date {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
    if (Number.isNaN(d.getTime())) throw new Error(`${field} "${value}" is not a date. Use YYYY-MM-DD.`);
    return d;
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
