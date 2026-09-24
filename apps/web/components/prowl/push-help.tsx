"use client";

import { useMemo } from "react";
import { encode } from "uqr";
import type { Device, DeviceBrowser } from "@prowl/shared";

const BROWSER_NAMES: Record<DeviceBrowser, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  firefox: "Firefox",
  safari: "Safari",
  other: "your browser",
};

/**
 * Where to look when a test push reached the browser but never showed. The
 * browser reports notifications as allowed even when the OS blocks them, so
 * the fix is always outside the page.
 */
function stepsFor({ os, browser }: Device): string[] {
  const name = BROWSER_NAMES[browser];
  switch (os) {
    case "mac":
      return [
        browser === "safari"
          ? "Open System Settings → Notifications, find pagealert.io or Safari, and turn on Allow notifications."
          : `Open System Settings → Notifications → ${name}, and turn on Allow notifications.`,
        "Make sure Focus is off. It's the moon icon in Control Centre.",
      ];
    case "windows":
      return [
        `Open Settings → System → Notifications. Turn notifications on, and on for ${name}.`,
        "Make sure Do not disturb is off.",
      ];
    case "android":
      return [
        `Open your phone's Settings → Apps → ${name} → Notifications, and allow them, including for pagealert.io.`,
        "Make sure Do Not Disturb is off.",
      ];
    case "ios":
      return [
        "Open Settings → Notifications → PageAlert, and turn on Allow Notifications.",
        "Make sure Focus is off. Swipe down from the top right to check.",
      ];
    case "other":
      return [
        `Check your system's notification settings allow ${name}.`,
        "Make sure Do Not Disturb is off.",
      ];
  }
}

export function PushNotShownSteps({ device }: { device: Device }) {
  return (
    <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
      {stepsFor(device).map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

/** A QR code drawn locally, so the link it encodes goes to no third party */
export function QrCode({
  value,
  label,
  className = "h-36 w-36",
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { data, size } = useMemo(() => encode(value, { border: 4 }), [value]);

  // One path for all the dark modules keeps the SVG small at any version
  const path = useMemo(() => {
    let d = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      })
    );
    return d;
  }, [data]);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={`${className} rounded-md`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      {/* Always dark on light: cameras read inverted codes badly */}
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
