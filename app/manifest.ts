import type { MetadataRoute } from "next"

const BRAND_ICON_URL = "/brand-icon.png?v=2"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ClaimGuard",
    short_name: "ClaimGuard",
    description:
      "Responsive employee and admin claims portals with offline-friendly PWA support.",
    start_url: "/",
    display: "standalone",
    background_color: "#EAF4F2",
    theme_color: "#0D5E6B",
    categories: ["business", "finance", "productivity"],
    icons: [
      {
        src: BRAND_ICON_URL,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: BRAND_ICON_URL,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: BRAND_ICON_URL,
        sizes: "512x512",
        type: "image/png",
      },
    ],
  }
}
