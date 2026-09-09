import { Gauge, List, TrendingDown, type LucideIcon } from "lucide-react";

export type MonitorModeId = "value" | "list" | "price";

export interface MonitorMode {
  id: MonitorModeId;
  icon: LucideIcon;
  label: string;
  /** Card copy on the landing page */
  description: string;
  /** Placeholder for the prompt field in the create form */
  placeholder: string;
  /** Helper line under the prompt field once this mode is picked */
  hint: string;
}

/**
 * Presentation only. Every mode runs the same AI extraction — picking one
 * changes the prompt guidance, not what the scraper does.
 */
export const MONITOR_MODES: MonitorMode[] = [
  {
    id: "value",
    icon: Gauge,
    label: "Watch a value",
    description:
      "A stock status, a count, a delivery date — anything that sits on the page as a single value. You hear about it when it changes.",
    placeholder: "e.g. tell me when the PS5 bundle shows as in stock",
    hint: "Name the value you care about and what it needs to say for you to hear about it.",
  },
  {
    id: "list",
    icon: List,
    label: "Watch a list",
    description:
      "Search results, job boards, classifieds. Items that appear or disappear reach you; the rest of the page stays quiet.",
    placeholder: "e.g. remote React jobs paying over £70k",
    hint: "Describe what a matching item looks like. New matches are what trigger the alert.",
  },
  {
    id: "price",
    icon: TrendingDown,
    label: "Track a price",
    description:
      "Follow the price of specific items and get told when it moves. Small wobbles are filtered out so a 2% drop doesn't wake you at 3am.",
    placeholder: "e.g. MacBook Pro 14-inch M4, alert me under £1,500",
    hint: "Say which items to follow and the price that matters to you.",
  },
];
