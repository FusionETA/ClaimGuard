import type { MetadataRoute } from "next"

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
        src: "/brand-logo.png",
        sizes: "1280x851",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/brand-logo.png",
        sizes: "1280x851",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/brand-logo.png",
        sizes: "1280x851",
        type: "image/png",
      },
    ],
  }
}
