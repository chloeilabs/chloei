import type { MetadataRoute } from "next"

import { installIconThemeColor } from "@/app/install-icon"

const isProduction = process.env.NODE_ENV === "production"

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: installIconThemeColor,
    description: "Multi-provider AI agent.",
    display: isProduction ? "standalone" : "browser",
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
    name: "Chloei",
    short_name: "Chloei",
    start_url: "/",
    theme_color: installIconThemeColor,
  }
}
