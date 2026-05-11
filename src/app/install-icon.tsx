import { ImageResponse } from "next/og"

import logoPixels from "@/lib/brand/chloei-logo-pixels.json"

const BRAND_BACKGROUND = "#0c0a09"

export const installIconThemeColor = BRAND_BACKGROUND

export function createInstallIconResponse(size: number) {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        backgroundColor: BRAND_BACKGROUND,
        color: "#ffffff",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <svg
        width="64%"
        height="64%"
        viewBox="0 0 11 11"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        shapeRendering="crispEdges"
      >
        {logoPixels.map(([x, y]) => (
          <rect
            key={`${String(x)}-${String(y)}`}
            x={x}
            y={y}
            width="1"
            height="1"
            fill="currentColor"
          />
        ))}
      </svg>
    </div>,
    {
      height: size,
      width: size,
    }
  )
}
