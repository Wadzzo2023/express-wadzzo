// src/agent/run.ts
//
// Everything one agent run owns: its progress steps (shown live), the result
// sets its tools found, and the cards and proposals it will save. One Run per
// job — nothing here is shared between brands or runs.

import { randomUUID } from "crypto";
import { setSteps } from "../lib/job-store";
import type {
    AgentBlock,
    AgentStep,
    CollectorItem,
    HotspotItem,
    PinItem,
    PlaceItem,
    ProposedAction,
    ReportBar,
    ReportStat,
} from "./contract";
import type { BrandContext } from "./context";

/** A set of things a tool found, which later tools can show or act on by its ref. */
export type ResultSet =
    | { kind: "places"; title: string; items: PlaceItem[]; area?: string }
    | { kind: "pins"; title: string; items: PinItem[] }
    | { kind: "hotspots"; title: string; items: HotspotItem[] }
    | { kind: "collectors"; title: string; items: CollectorItem[]; total: number }
    | { kind: "report"; title: string; stats: ReportStat[]; bars?: { title: string; items: ReportBar[] }; note?: string };

export type PendingAction = { id: string; action: ProposedAction; summary: string };

const shortId = () => randomUUID().replace(/-/g, "").slice(0, 10);

export class Run {
    readonly steps: AgentStep[] = [];
    readonly results = new Map<string, ResultSet>();
    readonly blocks: AgentBlock[] = [];
    readonly actions: PendingAction[] = [];
    /** Set when the agent asked a question: the run ends and waits for the answer. */
    asked = false;

    constructor(
        readonly jobId: string,
        readonly brand: BrandContext,
        readonly conversationId: string,
    ) {}

    // ── Progress ───────────────────────────────────────────────────────────

    /** Starts a visible step; finish it with done()/fail(). */
    step(label: string) {
        const step: AgentStep = { id: shortId(), label, status: "running" };
        this.steps.push(step);
        this.publish();
        return {
            done: (detail?: string) => this.finish(step, "done", detail),
            fail: (detail?: string) => this.finish(step, "error", detail),
        };
    }

    private finish(step: AgentStep, status: AgentStep["status"], detail?: string) {
        step.status = status;
        if (detail) step.detail = detail;
        this.publish();
    }

    private publish() {
        setSteps(this.jobId, this.steps.map((s) => ({ ...s })));
    }

    // ── Results ────────────────────────────────────────────────────────────

    /** Keeps a result set; returns the ref tools and the model use for it. */
    addResult(set: ResultSet): string {
        const ref = `${set.kind}_${shortId()}`;
        this.results.set(ref, set);
        return ref;
    }

    result<K extends ResultSet["kind"]>(ref: string, kind: K): Extract<ResultSet, { kind: K }> {
        const set = this.results.get(ref);
        if (!set) throw new Error(`Unknown ref "${ref}". Use a ref returned by a search or find tool.`);
        if (set.kind !== kind) throw new Error(`Ref "${ref}" holds ${set.kind}, not ${kind}.`);
        return set as Extract<ResultSet, { kind: K }>;
    }

    /** Adds a card for a result set (optionally only some of its items). */
    show(ref: string, title?: string, keys?: string[]): AgentBlock {
        const set = this.results.get(ref);
        if (!set) throw new Error(`Unknown ref "${ref}".`);
        const pick = <T extends { id?: string; key?: string }>(items: T[]) =>
            keys?.length ? items.filter((i) => keys.includes((i.key ?? i.id)!)) : items;

        let block: AgentBlock;
        switch (set.kind) {
            case "places":
                block = { kind: "places", id: ref, title: title ?? set.title, items: pick(set.items), area: set.area };
                break;
            case "pins":
                block = { kind: "pins", id: ref, title: title ?? set.title, items: pick(set.items) };
                break;
            case "hotspots":
                block = { kind: "hotspots", id: ref, title: title ?? set.title, items: pick(set.items) };
                break;
            case "collectors":
                block = { kind: "collectors", id: ref, title: title ?? set.title, items: set.items, total: set.total };
                break;
            case "report":
                block = { kind: "report", id: ref, title: title ?? set.title, stats: set.stats, bars: set.bars, note: set.note };
                break;
        }
        // Showing the same ref twice replaces the earlier card.
        const at = this.blocks.findIndex((b) => b.id === block.id);
        if (at >= 0) this.blocks[at] = block;
        else this.blocks.push(block);
        return block;
    }

    // ── Questions and proposals ───────────────────────────────────────────

    ask(block: Extract<AgentBlock, { kind: "choices" }>) {
        this.blocks.push(block);
        this.asked = true;
    }

    propose(action: ProposedAction, summary: string): PendingAction {
        const pending = { id: `act_${shortId()}`, action, summary };
        this.actions.push(pending);
        return pending;
    }
}
