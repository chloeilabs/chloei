"use client"

import "./logo-animation.css"

import { AnimatedLogo, type LogoSize } from "./logo-animated"
import { ChloeiLogoHoverSvg } from "./logo-hover-svg"
import { ChloeiLogoSvg } from "./logo-svg"

export function LogoHover({
  forceAnimate,
  size = "md",
  className,
}: {
  forceAnimate?: boolean
  size?: LogoSize
  className?: string
}) {
  return (
    <AnimatedLogo
      className={className}
      forceAnimate={forceAnimate}
      size={size}
      renderAnimatedLogo={(logoClassName) => (
        <ChloeiLogoHoverSvg className={logoClassName} />
      )}
      renderStaticLogo={(logoClassName) => (
        <ChloeiLogoSvg className={logoClassName} />
      )}
    />
  )
}
