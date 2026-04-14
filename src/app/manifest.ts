import type { MetadataRoute } from "next"

import { installIconThemeColor } from "@/app/install-icon"

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: installIconThemeColor,
    description: "Multi-provider AI agent.",
    display: "standalone",
    icons: [
      {
        purpose: "maskable",
        sizes: "192x192",
        src: "/icon-192",
        type: "image/png",
      },
      {
        purpose: "maskable",
        sizes: "512x512",
        src: "/icon-512",
        type: "image/png",
      },
    ],
    name: "Yurie",
    short_name: "Yurie",
    start_url: "/",
    theme_color: installIconThemeColor,
  }
}
