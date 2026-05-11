import logoPixels from "@/lib/brand/chloei-logo-pixels.json"
import { cn } from "@/lib/utils"

export function ChloeiLogoSvg({ className }: { className?: string }) {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 11 11"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-full fill-current", className)}
    >
      {logoPixels.map(([x, y]) => (
        <rect
          key={`${String(x)}-${String(y)}`}
          x={x}
          y={y}
          width="1"
          height="1"
        />
      ))}
    </svg>
  )
}
