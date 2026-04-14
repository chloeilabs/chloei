import "./refresh-glow.css"

import { cn } from "@/lib/utils"

export function RefreshGlow({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "refresh-glow absolute top-40 -z-10 h-[calc(100svh-12rem)] w-full max-w-5xl rounded-[50%] bg-muted",
        className
      )}
    />
  )
}
