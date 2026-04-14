"use client"

import { useState } from "react"

import { cn } from "@/lib/utils"

const sizes = {
  xs: {
    width: 14,
    animateWidth: 210,
    height: 14,
    className: "logo-xs",
  },
  sm: {
    width: 16,
    animateWidth: 240,
    height: 16,
    className: "logo-sm",
  },
  md: {
    width: 20,
    animateWidth: 300,
    height: 20,
    className: "logo-md",
  },
  lg: {
    width: 25,
    animateWidth: 375,
    height: 25,
    className: "logo-lg",
  },
} as const

export type LogoSize = keyof typeof sizes

interface AnimatedLogoProps {
  forceAnimate?: boolean
  size?: LogoSize
  className?: string
  renderAnimatedLogo: (className: string) => React.ReactNode
  renderStaticLogo: (className: string) => React.ReactNode
}

export function AnimatedLogo({
  forceAnimate,
  size = "md",
  className,
  renderAnimatedLogo,
  renderStaticLogo,
}: AnimatedLogoProps) {
  const [isAnimating, setIsAnimating] = useState(false)
  const logoSize = sizes[size]
  const shouldAnimate = forceAnimate ?? isAnimating

  return (
    <div
      className={cn("overflow-hidden", className)}
      style={{ width: logoSize.width, height: logoSize.height }}
      onMouseEnter={() => {
        setIsAnimating(true)
      }}
      onMouseLeave={() => {
        setIsAnimating(false)
      }}
    >
      <div
        style={{
          width: shouldAnimate ? logoSize.animateWidth : logoSize.width,
          height: logoSize.height,
        }}
      >
        {shouldAnimate
          ? renderAnimatedLogo(logoSize.className)
          : renderStaticLogo(logoSize.className)}
      </div>
    </div>
  )
}
