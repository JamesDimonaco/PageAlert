"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/** VAPID keys arrive base64url; PushManager wants raw bytes */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** Running from the home screen rather than in a browser tab */
function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export type PushState =
  | "loading"
  /** No service worker or PushManager at all */
  | "unsupported"
  /** iOS Safari in a tab — push only works once the site is on the home screen */
  | "needs-install"
  /** Supported, not subscribed on this device */
  | "off"
  /** Subscribed on this device */
  | "on"
  /** The user said no; the browser won't ask again until they undo it */
  | "denied";

/** What push can do on this device right now */
async function detectState(): Promise<PushState> {
  if (typeof window === "undefined") return "loading";

  // The fallback matters as much as the happy path: anything thrown here
  // would otherwise leave the card saying "Checking this device..." forever,
  // and the iOS install steps would never appear for the people who need them.
  const cannot: PushState = isIos() && !isStandalone() ? "needs-install" : "unsupported";

  try {
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      typeof Notification === "undefined"
    ) {
      return cannot;
    }
    if (Notification.permission === "denied") return "denied";

    const registration = await navigator.serviceWorker.getRegistration();
    const existing = await registration?.pushManager.getSubscription();
    return existing ? "on" : "off";
  } catch {
    // Blocked site data, a locked-down webview, a rejected registration read
    return cannot;
  }
}

export function usePush() {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);

  const subscribeMutation = useMutation(api.pushSubscriptions.subscribe);
  const unsubscribeMutation = useMutation(api.pushSubscriptions.unsubscribe);
  const deviceCount = useQuery(api.pushSubscriptions.deviceCount);

  useEffect(() => {
    let cancelled = false;
    void detectState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) throw new Error("Push is not configured on this deployment");

      // Permission first. Safari — including the iOS home-screen app this
      // whole feature targets — wants the prompt raised under the user
      // gesture, and awaiting the service worker registration first can spend
      // that activation, leaving the prompt unshown and the call rejected.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        throw new Error("Notification permission was not granted");
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      // Reuse the existing subscription if there is one — resubscribing with
      // the same key returns the same endpoint anyway, and a stored row that
      // the server never heard about is worse than a redundant upsert.
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
        }));

      const json = subscription.toJSON();
      if (!json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("Browser returned an incomplete push subscription");
      }

      await subscribeMutation({
        endpoint: subscription.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        userAgent: navigator.userAgent.slice(0, 200),
      });
      setState("on");
    } finally {
      setBusy(false);
    }
  }, [subscribeMutation]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await unsubscribeMutation({ endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }, [unsubscribeMutation]);

  // The browser's subscription and the server's rows can disagree — most
  // obviously when someone else signed in on a device that was already
  // subscribed. Trusting the browser alone would tell them push is on while
  // nothing ever arrives.
  const reconciled: PushState =
    state === "on" && deviceCount === 0 ? "off" : state;

  return { state: reconciled, busy, enable, disable, deviceCount: deviceCount ?? 0 };
}
