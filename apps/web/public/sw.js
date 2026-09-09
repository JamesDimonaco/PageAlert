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

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "PageAlert", {
      body: payload.body ?? "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Repeat alerts for one monitor replace each other rather than stacking
      tag: payload.tag,
      data: { url: payload.url ?? "/dashboard" },
    })
  );
});

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
