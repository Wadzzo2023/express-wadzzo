// src/agent/tools/ui.ts — cards the person sees: results and questions.

import { z } from "zod";
import { defineTool } from "./define";

export const uiTools = [
    defineTool({
        name: "show_results",
        description:
            "Show a result set (any ref from a search/find/report tool) to the person as a card; places and pins also appear on the map. " +
            "Optionally only some items (their keys/ids). Always show results you talk about — don't list them in your reply.",
        schema: z.object({
            ref: z.string(),
            title: z.string().max(80).optional().describe("Card title, e.g. 'Parks in Clinton County'"),
            only: z.array(z.string()).max(200).optional().describe("Keys (places) or ids (pins, hotspots) to show; omit for all"),
        }),
        quiet: true,
        label: () => "",
        run: async (a, run) => {
            const block = run.show(a.ref, a.title, a.only);
            const count = "items" in block ? block.items.length : 0;
            return { model: { shown: true, card: block.kind, items: count } };
        },
    }),

    defineTool({
        name: "ask_user",
        description:
            "Ask the person ONE question with tappable options when you genuinely need their choice to continue (which area, which pins, " +
            "what kind of places, which settings). Ends your turn: their answer comes back as their next message. Prefer 2–6 short options. " +
            "Don't ask what you can find out with a tool, and don't ask for confirmation of changes — propose them instead.",
        schema: z.object({
            question: z.string().max(200),
            options: z
                .array(z.object({ label: z.string().max(60), description: z.string().max(140).optional() }))
                .min(2)
                .max(8),
            multiple: z.boolean().default(false).describe("Let them pick several"),
            allowOther: z.boolean().default(true).describe("Also let them type their own answer"),
        }),
        quiet: true,
        label: () => "",
        run: async (a, run) => {
            run.ask({
                kind: "choices",
                id: `ask_${run.blocks.length + 1}_${Date.now().toString(36)}`,
                question: a.question,
                options: a.options.map((o, i) => ({ id: `o${i + 1}`, label: o.label, description: o.description })),
                multiple: a.multiple,
                allowOther: a.allowOther,
            });
            return { model: { asked: true, note: "Stop here. Write one short sentence, if anything; the card carries the question." } };
        },
    }),
];
