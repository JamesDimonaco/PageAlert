import type { MetadataRoute } from "next";

/**
 * Installable-app manifest. Needed for push on iOS, where notifications only
 * work once the site has been added to the home screen — on desktop and
 * Android push works without installing, so this is the iPhone path.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PageAlert",
    short_name: "PageAlert",
    description:
      "Monitor any website for price drops, restocks and new listings. Describe what you want in plain English.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#3b82f6",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
