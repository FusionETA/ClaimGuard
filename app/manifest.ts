import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ClaimGuard",
    short_name: "ClaimGuard",
    description:
      "Responsive employee and admin claims portals with offline-friendly PWA support.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f9fb",
    theme_color: "#0a396c",
    categories: ["business", "finance", "productivity"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  }
}
