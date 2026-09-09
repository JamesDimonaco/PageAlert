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

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    // On iOS this is the tab case, which the user can fix by installing.
    // Everywhere else the browser simply can't do push.
    return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";

  const registration = await navigator.serviceWorker.getRegistration();
  const existing = await registration?.pushManager.getSubscription();
  return existing ? "on" : "off";
}

export function usePush() {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);

  const subscribeMutation = useMutation(api.pushSubscriptions.subscribe);
  const unsubscribeMutation = useMutation(api.pushSubscriptions.unsubscribe);
  const deviceCount = useQuery(api.pushSubscriptions.deviceCount);

  const refresh = useCallback(async () => {
    setState(await detectState());
  }, []);

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

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        throw new Error("Notification permission was not granted");
      }

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

  return { state, busy, enable, disable, deviceCount: deviceCount ?? 0, refresh };
}
