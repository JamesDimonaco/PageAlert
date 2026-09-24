// PageAlert service worker. Its only job is push — there is no offline
// caching here, and adding any would put a stale shell in front of a live
// Convex app.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "PageAlert", body: event.data.text() };
  }

  const options = {
    body: payload.body ?? "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [200, 100, 200],
    // Repeat alerts for one monitor replace each other rather than stacking
    tag: payload.tag,
    data: { url: payload.url ?? "/dashboard" },
  };
  // renotify makes a repeat alert re-vibrate instead of swapping silently,
  // but it throws a TypeError without a tag to renotify against.
  if (payload.tag) options.renotify = true;

  event.waitUntil(
    self.registration
      .showNotification(payload.title ?? "PageAlert", options)
      .then(() => tellPages(payload.tag))
  );
});

// Tell any open PageAlert tab the push landed. The settings test uses this to
// split "never reached this browser" from "arrived but the OS hid it" — the
// browser reports notifications as allowed even when the OS blocks them, so
// that second case can only be caught by asking the user.
async function tellPages(tag) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "push-received", tag });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/dashboard";

  // Reuse an open PageAlert tab if there is one — opening a second copy of
  // the dashboard on every alert gets old fast.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes("/dashboard") && "focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
