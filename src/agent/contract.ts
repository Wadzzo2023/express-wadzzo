/**
 * The map agent's contract between the task server (which runs the agent) and
 * the brand app (which shows it and carries out confirmed actions).
 *
 * KEEP IN SYNC: this file is copied verbatim to
 * package/express-wadzzo/src/agent/contract.ts (a separate repo).
 * tests/agent-contract.test.ts fails if the two copies differ.
 */

// ─── Progress ────────────────────────────────────────────────────────────────

/** One thing the agent is doing or did, e.g. "Searching parks in Clinton County…". */
export type AgentStep = {
  id: string;
  label: string;
  status: "running" | "done" | "error";
  /** Outcome once finished, e.g. "Found 12 places". */
  detail?: string;
};

// ─── Items shown in cards ────────────────────────────────────────────────────

export type PinTypeName = "EVENT" | "BOUNTY" | "EXPERIENCE" | "LAUNCH" | "OTHER" | "LANDMARK";

/** A real-world place (or event venue) found by a search, not yet a pin. */
export type PlaceItem = {
  key: string;
  title: string;
  address?: string;
  lat: number;
  lng: number;
  kind: "place" | "event";
  startDate?: string;
  endDate?: string;
  url?: string;
  image?: string;
  gPlaceId?: string;
  /** The brand already has a pin within a few metres of it. */
  alreadyPinned?: boolean;
};

export type PinStatus = "active" | "upcoming" | "expired" | "in_review" | "rejected";

export type PinItem = {
  id: string;
  title: string;
  type: PinTypeName;
  lat: number;
  lng: number;
  startDate: string;
  endDate: string;
  status: PinStatus;
  locations: number;
  collected: number;
  image?: string | null;
  hotspotId?: string | null;
};

export type HotspotItem = {
  id: string;
  title: string;
  isActive: boolean;
  dropEveryDays: number;
  pinDurationDays: number;
  startDate: string;
  endDate: string;
  autoCollect: boolean;
  drops: number;
  /** Stored [lat, lng] polygon Feature (map kit format). */
  geoJson: unknown;
};

export type EventItem = {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  venueName?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  rsvps: number;
};

export type AnnouncementItem = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  expiresAt?: string | null;
  comments: number;
};

/** A fan who collected the brand's pins. Shown to the brand only, never sent to the AI. */
export type CollectorItem = {
  name: string | null;
  email: string | null;
  collected: number;
  redeemed: number;
  lastAt: string;
};

export type ReportStat = { label: string; value: string; hint?: string };
export type ReportBar = { label: string; value: number };

// ─── Cards ───────────────────────────────────────────────────────────────────

export type ChoiceOption = { id: string; label: string; description?: string };

export type AgentBlock =
  | {
      kind: "choices";
      id: string;
      question: string;
      options: ChoiceOption[];
      multiple: boolean;
      /** Offer a free-text answer as well. */
      allowOther: boolean;
      /** Labels the person picked, once answered. */
      answered?: string[];
    }
  | { kind: "places"; id: string; title: string; items: PlaceItem[]; area?: string }
  | { kind: "pins"; id: string; title: string; items: PinItem[] }
  | { kind: "hotspots"; id: string; title: string; items: HotspotItem[] }
  | { kind: "events"; id: string; title: string; items: EventItem[] }
  | { kind: "announcements"; id: string; title: string; items: AnnouncementItem[] }
  | { kind: "collectors"; id: string; title: string; items: CollectorItem[]; total: number }
  | { kind: "report"; id: string; title: string; stats: ReportStat[]; bars?: { title: string; items: ReportBar[] }; note?: string }
  | { kind: "proposal"; id: string; actionId: string; action: ProposedAction; summary: string };

export type AgentBlockKind = AgentBlock["kind"];

// ─── Proposed changes (carried out by the brand app after confirmation) ─────

export type PinDefaults = {
  type: PinTypeName;
  startDate: string;
  endDate: string;
  autoCollect: boolean;
  /** Collectible copies dropped at each place. */
  pinNumber: number;
  /** Collection radius in metres. */
  radius: number;
  /** Total collections allowed per pin, at least 1 (UNLIMITED_COLLECTIONS = no practical limit). */
  collectionLimit: number;
  /** One pin per place, or every place in one pin. */
  grouping: "per-location" | "single-group";
};

/** The "unlimited" collection limit, as the pin tools have always stored it. */
export const UNLIMITED_COLLECTIONS = 999_999;

export type PinChanges = {
  title?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  link?: string;
  image?: string;
  collectionLimit?: number;
  autoCollect?: boolean;
};

export type HotspotChanges = {
  startDate?: string;
  endDate?: string;
  dropEveryDays?: number;
  pinDurationDays?: number;
  autoCollect?: boolean;
};

export type HotspotDraft = {
  title: string;
  description?: string;
  /** Circle centre and radius. */
  lat: number;
  lng: number;
  radiusMetres: number;
  type: PinTypeName;
  startDate: string;
  endDate: string;
  dropEveryDays: number;
  pinDurationDays: number;
  pinNumber: number;
  collectionLimit: number;
  autoCollect: boolean;
};

export type EventDraft = {
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  venueName?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  link?: string | null;
  capacity?: number | null;
};

export type AnnouncementDraft = {
  title: string;
  body: string;
  pinned: boolean;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  expiresAt?: string | null;
};

/** Items named in a proposal, for showing what it touches. */
export type NamedRef = { id: string; title: string };

export type ProposedAction =
  | { type: "create_pins"; items: PlaceItem[]; defaults: PinDefaults }
  | { type: "update_pins"; pins: NamedRef[]; changes: PinChanges }
  | { type: "hide_pins"; pins: NamedRef[] }
  | { type: "hotspot_state"; hotspot: NamedRef; op: "pause" | "resume" | "delete" }
  | { type: "update_hotspot"; hotspot: NamedRef; changes: HotspotChanges }
  | { type: "create_hotspot"; hotspot: HotspotDraft }
  | { type: "create_event"; event: EventDraft }
  | { type: "update_event"; event: NamedRef; changes: Partial<EventDraft> }
  | { type: "delete_event"; event: NamedRef }
  | { type: "create_announcement"; announcement: AnnouncementDraft }
  | { type: "update_announcement"; announcement: NamedRef; changes: Partial<AnnouncementDraft> }
  | { type: "delete_announcement"; announcement: NamedRef };

export type ProposedActionType = ProposedAction["type"];

/** What the person may adjust on a proposal card before confirming. */
export type ActionEdits = {
  /** create_pins: the place keys to keep (default: all). */
  keep?: string[];
  /** create_pins: changed defaults. */
  defaults?: Partial<PinDefaults>;
  /** create_event / create_announcement / create_hotspot: changed draft fields. */
  draft?: Record<string, unknown>;
};

export type ActionStatus = "pending" | "running" | "done" | "failed" | "cancelled";

// ─── Agent run (one job on the task server) ─────────────────────────────────

/** What the brand app sends to start a run. History is read from the database. */
export type AgentRunPayload = {
  conversationId: string;
  creatorId: string;
  platformId: string;
  /** The person's IANA time zone, so "today" and "this weekend" mean their dates. */
  timeZone?: string;
};

/** A finished run: the assistant message the task server saved. */
export type AgentRunResult = { messageId: string };
