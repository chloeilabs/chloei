import { ImageResponse } from "next/og"

import logoPixels from "@/lib/brand/chloei-logo-pixels.json"
import { appBackgroundColor } from "@/lib/brand/colors"

export const installIconThemeColor = appBackgroundColor

export function createInstallIconResponse(size: number) {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        backgroundColor: appBackgroundColor,
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
