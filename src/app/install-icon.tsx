import { ImageResponse } from "next/og"

const BRAND_BACKGROUND = "#0c0a09"
const LOGO_PIXELS = [
  [0, 5],
  [1, 1],
  [1, 5],
  [1, 9],
  [2, 2],
  [2, 5],
  [2, 8],
  [3, 3],
  [3, 5],
  [3, 7],
  [5, 0],
  [5, 1],
  [5, 2],
  [5, 3],
  [5, 7],
  [5, 8],
  [5, 9],
  [5, 10],
  [7, 3],
  [7, 5],
  [7, 7],
  [8, 2],
  [8, 5],
  [8, 8],
  [9, 1],
  [9, 5],
  [9, 9],
  [10, 5],
] as const

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
        {LOGO_PIXELS.map(([x, y]) => (
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
