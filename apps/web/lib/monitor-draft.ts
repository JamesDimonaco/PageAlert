/**
 * Local-storage persistence for the in-progress create-monitor form.
 *
 * The user can start filling out the form, navigate away (e.g. to Settings to
 * set up Telegram), and come back to find their input restored. The draft is
 * cleared on successful scan start, on explicit "Start over", and on logout.
 *
 * See PROWL-038 Phase 3.
 */

export type MonitorDraftChannel = "email" | "telegram" | "discord";
export type MonitorDraftCheckInterval = "5m" | "15m" | "30m" | "1h" | "6h" | "24h";

export interface MonitorDraft {
  name: string;
  url: string;
  prompt: string;
  checkInterval: MonitorDraftCheckInterval;
  channels: MonitorDraftChannel[];
  updatedAt: number;
}

export const MONITOR_DRAFT_KEY = "pagealert_monitor_draft";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const VALID_INTERVALS: MonitorDraftCheckInterval[] = ["5m", "15m", "30m", "1h", "6h", "24h"];
const VALID_CHANNELS: MonitorDraftChannel[] = ["email", "telegram", "discord"];

function isValidDraft(value: unknown): value is MonitorDraft {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string") return false;
  if (typeof v.url !== "string") return false;
  if (typeof v.prompt !== "string") return false;
  if (typeof v.updatedAt !== "number") return false;
  if (!VALID_INTERVALS.includes(v.checkInterval as MonitorDraftCheckInterval)) return false;
  if (!Array.isArray(v.channels)) return false;
  if (!v.channels.every((c) => VALID_CHANNELS.includes(c as MonitorDraftChannel))) return false;
  return true;
}

/** Read the persisted draft if it exists, is valid, and hasn't expired. */
export function readMonitorDraft(): MonitorDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MONITOR_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidDraft(parsed)) {
      window.localStorage.removeItem(MONITOR_DRAFT_KEY);
      return null;
    }
    if (Date.now() - parsed.updatedAt > DRAFT_TTL_MS) {
      window.localStorage.removeItem(MONITOR_DRAFT_KEY);
      return null;
    }
    return parsed;
  } catch {
    // Quota exceeded, JSON parse error, private mode, etc. — silently fail.
    return null;
  }
}

/** Write the draft. Skipped entirely if all of name/url/prompt are empty. */
export function writeMonitorDraft(draft: Omit<MonitorDraft, "updatedAt">): void {
  if (typeof window === "undefined") return;
  const hasContent = draft.name.trim() || draft.url.trim() || draft.prompt.trim();
  if (!hasContent) {
    // Don't pollute storage with empty drafts on every form open.
    return;
  }
  try {
    const payload: MonitorDraft = { ...draft, updatedAt: Date.now() };
    window.localStorage.setItem(MONITOR_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // Storage failure — fall back to in-memory state only.
  }
}

export function clearMonitorDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MONITOR_DRAFT_KEY);
  } catch {
    // ignore
  }
}
