export type DeviceOs = "ios" | "android" | "mac" | "windows" | "other";
export type DeviceBrowser = "chrome" | "edge" | "firefox" | "safari" | "other";

export interface Device {
  os: DeviceOs;
  browser: DeviceBrowser;
}

/**
 * Which operating system and browser a user agent belongs to, for pointing
 * people at the right notification settings.
 *
 * Takes maxTouchPoints because iPadOS Safari sends a Mac user agent by
 * default; touch is the only thing that gives it away.
 */
export function detectDevice(userAgent: string, maxTouchPoints: number): Device {
  return { os: detectOs(userAgent, maxTouchPoints), browser: detectBrowser(userAgent) };
}

function detectOs(ua: string, maxTouchPoints: number): DeviceOs {
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/macintosh/i.test(ua)) return maxTouchPoints > 1 ? "ios" : "mac";
  // Android user agents also say Linux, so this has to come first
  if (/android/i.test(ua)) return "android";
  if (/windows/i.test(ua)) return "windows";
  return "other";
}

function detectBrowser(ua: string): DeviceBrowser {
  // Edge, Samsung Internet and Opera all carry a Chrome token too
  if (/edg(e|a|ios)?\//i.test(ua)) return "edge";
  if (/samsungbrowser|opr\//i.test(ua)) return "other";
  if (/firefox|fxios/i.test(ua)) return "firefox";
  if (/chrome|crios/i.test(ua)) return "chrome";
  if (/safari/i.test(ua)) return "safari";
  return "other";
}
