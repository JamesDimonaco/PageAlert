import { describe, expect, it } from "vitest";
import { detectDevice } from "./device";

// Real user-agent strings. The device decides which settings screen we send a
// stuck user to, so a wrong answer here points them at the wrong fix.
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  // iPadOS Safari asks for the desktop site by default and sends this
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  macEdge:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
  windowsFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
};

describe("detectDevice", () => {
  it("reads an iPhone as iOS whichever browser it is in", () => {
    expect(detectDevice(UA.iphoneSafari, 5).os).toBe("ios");
    expect(detectDevice(UA.iphoneChrome, 5).os).toBe("ios");
  });

  it("reads an iPad posing as a Mac as iOS, because only iOS has touch", () => {
    expect(detectDevice(UA.macSafari, 5).os).toBe("ios");
  });

  it("reads a real Mac as a Mac", () => {
    expect(detectDevice(UA.macSafari, 0)).toEqual({ os: "mac", browser: "safari" });
    expect(detectDevice(UA.macChrome, 0)).toEqual({ os: "mac", browser: "chrome" });
  });

  it("tells Edge from the Chrome it claims to be", () => {
    expect(detectDevice(UA.macEdge, 0)).toEqual({ os: "mac", browser: "edge" });
  });

  it("reads Windows and Firefox", () => {
    expect(detectDevice(UA.windowsFirefox, 0)).toEqual({ os: "windows", browser: "firefox" });
  });

  it("reads Android before the Linux it also claims", () => {
    expect(detectDevice(UA.androidChrome, 5)).toEqual({ os: "android", browser: "chrome" });
  });

  it("does not call Samsung Internet Chrome, whose settings live elsewhere", () => {
    expect(detectDevice(UA.androidSamsung, 5)).toEqual({ os: "android", browser: "other" });
  });

  it("falls back to other for desktop Linux", () => {
    expect(detectDevice(UA.linuxFirefox, 0)).toEqual({ os: "other", browser: "firefox" });
  });
});
